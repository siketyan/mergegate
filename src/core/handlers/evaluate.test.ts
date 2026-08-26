import { expect, test } from "vite-plus/test";
import {
  createFakeGitHub,
  createTestContext,
  type FakeGitHubState,
  pullRequest,
  repo,
} from "../../../test/fake-github.ts";
import type { PullRequestState } from "../ports.ts";
import { evaluatePullRequest } from "./evaluate.ts";

const CONFIG = `
version: 1
rules:
  - base: staging
    head: develop
    strategy: merge
  - base: production
    strategy: forbid
  - base: "**"
    strategy: squash
`;

async function run(
  state: Partial<FakeGitHubState>,
  overrides: Partial<PullRequestState> = {},
): Promise<FakeGitHubState> {
  return (await runWithContext(state, overrides)).state;
}

async function runWithContext(
  state: Partial<FakeGitHubState>,
  overrides: Partial<PullRequestState> = {},
): Promise<{ state: FakeGitHubState; slept: number[] }> {
  const pull = pullRequest(overrides);
  const { api, state: fake } = createFakeGitHub({
    configSource: CONFIG,
    pullRequests: new Map([[pull.number, pull]]),
    ...state,
  });
  const { context, slept } = createTestContext(api);
  await evaluatePullRequest(context, api, repo, pull.number);
  return { state: fake, slept };
}

test("a squash pull request only gets a passing check", async () => {
  const state = await run({}, { base: "develop", head: "feature/login" });
  expect(state.checkRuns).toHaveLength(1);
  expect(state.checkRuns[0]).toMatchObject({
    name: "mergegate",
    headSha: "c0ffee",
    conclusion: "success",
    title: "Squash merge",
  });
  expect(state.merges).toHaveLength(0);
});

test("an assisted pull request without the label is blocked", async () => {
  const state = await run({});
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "action_required",
    title: "Merge commit required",
  });
  expect(state.merges).toHaveLength(0);
});

test("a labelled pull request is merged with the evaluated head SHA", async () => {
  const state = await run({}, { labels: ["ready-to-merge"] });
  expect(state.merges).toEqual([
    {
      pullNumber: 12,
      input: {
        method: "merge",
        sha: "c0ffee",
        commitTitle: "Merge develop into staging (#12)",
        commitMessage: "",
      },
    },
  ]);
  expect(state.checkRuns.at(-1)).toMatchObject({
    conclusion: "success",
    title: "Merged by mergegate",
  });
});

test("the label alone is not enough", async () => {
  const state = await run({}, { labels: ["ready-to-merge"], otherChecks: ["failure"] });
  expect(state.merges).toHaveLength(0);
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "action_required",
    title: "Waiting for other checks",
  });
});

test("a permanent merge failure drops the label so re-adding it retries", async () => {
  const state = await run(
    { mergeOutcome: { ok: false, kind: "conflict", message: "Merge conflict" } },
    { labels: ["ready-to-merge"] },
  );
  expect(state.removedLabels).toEqual([{ pullNumber: 12, label: "ready-to-merge" }]);
});

test("a head that moved under us keeps the label and waits for the next event", async () => {
  const state = await run(
    { mergeOutcome: { ok: false, kind: "head-changed", message: "Head branch was modified" } },
    { labels: ["ready-to-merge"] },
  );
  expect(state.removedLabels).toHaveLength(0);
  expect(state.checkRuns.at(-1)).toMatchObject({ conclusion: "action_required" });
});

test("a forbidden pair fails permanently", async () => {
  const state = await run({}, { base: "production", head: "develop" });
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "failure",
    title: "Pull requests into production from develop are not allowed",
  });
});

test("an unreadable configuration fails closed under the default check name", async () => {
  const state = await run({ configSource: "version: 1\nrules: [\n" });
  expect(state.ownCheckNames).toEqual(["mergegate"]);
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "failure",
    title: "Invalid .github/mergegate.yml",
  });
});

test("a repository with no configuration file lets everything through as squash", async () => {
  const state = await run({ configSource: null });
  expect(state.checkRuns[0]).toMatchObject({ conclusion: "success", title: "Squash merge" });
});

test("a closed pull request is left alone", async () => {
  const state = await run({}, { state: "closed" });
  expect(state.checkRuns).toHaveLength(0);
});

const TRANSITIVE_CONFIG = `
version: 1
rules:
  - base: staging
    head: develop
    includeTransitive: true
    strategy: merge
  - base: "**"
    strategy: squash
`;

test("a branch carrying the source is treated as the promotion it is", async () => {
  const state = await run(
    { configSource: TRANSITIVE_CONFIG, carriedFrom: ["develop"] },
    { head: "resolve-the-conflicts" },
  );

  expect(state.carriesQueries).toEqual([
    { base: "staging", head: "resolve-the-conflicts", source: "develop" },
  ]);
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "action_required",
    title: "Merge commit required",
  });
});

test("a branch carrying nothing from the source is an ordinary feature", async () => {
  const state = await run(
    { configSource: TRANSITIVE_CONFIG, carriedFrom: [] },
    { head: "just-a-feature" },
  );
  expect(state.checkRuns[0]).toMatchObject({ conclusion: "success", title: "Squash merge" });
});

test("a head that already matches by name is never looked up", async () => {
  const state = await run({ configSource: TRANSITIVE_CONFIG, carriedFrom: ["develop"] });
  expect(state.carriesQueries).toEqual([]);
  expect(state.checkRuns[0]).toMatchObject({ title: "Merge commit required" });
});

test("a configuration without includeTransitive costs no lookups", async () => {
  const state = await run({}, { head: "resolve-the-conflicts" });
  expect(state.carriesQueries).toEqual([]);
});

const LABELLED = { labels: ["ready-to-merge"] };

test("undetermined mergeability is waited out, not left to an event that may not come", async () => {
  const settling = pullRequest({ ...LABELLED, mergeable: true });
  const { state, slept } = await runWithContext(
    { nextStates: [pullRequest({ ...LABELLED, mergeable: null }), settling] },
    { ...LABELLED, mergeable: null },
  );

  expect(slept).toEqual([2000]);
  expect(state.merges).toHaveLength(1);
  expect(state.checkRuns.at(-1)).toMatchObject({ title: "Merged by mergegate" });
});

test("the wait is bounded", async () => {
  const unknown = () => pullRequest({ ...LABELLED, mergeable: null });
  const { state, slept } = await runWithContext(
    { nextStates: [unknown(), unknown(), unknown(), unknown()] },
    { ...LABELLED, mergeable: null },
  );

  expect(slept).toEqual([2000, 4000, 8000]);
  expect(state.merges).toHaveLength(0);
  expect(state.checkRuns.at(-1)).toMatchObject({
    conclusion: "action_required",
    title: "Waiting for GitHub to compute mergeability",
  });
});

test("a push during the wait hands the pull request to its own event", async () => {
  const { state } = await runWithContext(
    {
      nextStates: [
        pullRequest({ ...LABELLED, mergeable: null }),
        pullRequest({ ...LABELLED, mergeable: true, headSha: "moved" }),
      ],
    },
    { ...LABELLED, mergeable: null },
  );

  // Nothing is written against a head that is no longer current.
  expect(state.checkRuns).toHaveLength(0);
  expect(state.merges).toHaveLength(0);
});
