import { expect, test } from "vite-plus/test";
import {
  createFakeGitHub,
  createTestContext,
  type FakeGitHubState,
  pullRequest,
  repo,
} from "../../test/fake-github.ts";
import { type GitHubApi, GitHubApiError, type PullRequestState } from "../ports.ts";
import { type EvaluateOptions, evaluatePullRequest } from "./evaluate.ts";

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
  options: EvaluateOptions = {},
): Promise<FakeGitHubState> {
  return (await runWithContext(state, overrides, options)).state;
}

async function runWithContext(
  state: Partial<FakeGitHubState>,
  overrides: Partial<PullRequestState> = {},
  options: EvaluateOptions = {},
): Promise<{ state: FakeGitHubState; slept: number[] }> {
  const pull = pullRequest(overrides);
  const { api, state: fake } = createFakeGitHub({
    configSource: CONFIG,
    pullRequests: new Map([[pull.number, pull]]),
    ...state,
  });
  const { context, slept } = createTestContext(api);
  await evaluatePullRequest(context, api, repo, pull.number, options);
  return { state: fake, slept };
}

/** A press of the button on the commit the pull request is actually at. */
const PRESSED: EvaluateOptions = {
  mergeRequest: { headSha: "c0ffee", actor: "maintainer" },
};

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
      // No commit title or message: the configuration names neither, so the
      // merge call carries neither and GitHub writes its own.
      input: { method: "merge", sha: "c0ffee" },
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

test("the back merge is looked up from the other end", async () => {
  // base and head swap places under includeReversed, so the branch whose
  // commits are followed swaps with them.
  const state = await run(
    {
      configSource: `
version: 1
rules:
  - base: staging
    head: develop
    includeTransitive: true
    includeReversed: true
    strategy: merge
  - base: "**"
    strategy: squash
`,
      carriedFrom: ["staging"],
    },
    { base: "develop", head: "resolve-the-conflicts" },
  );

  expect(state.carriesQueries).toEqual([
    { base: "develop", head: "resolve-the-conflicts", source: "staging" },
  ]);
  expect(state.checkRuns[0]).toMatchObject({
    conclusion: "action_required",
    title: "Merge commit required",
  });
});

test("a configuration without includeTransitive costs no lookups", async () => {
  const state = await run({}, { head: "resolve-the-conflicts" });
  expect(state.carriesQueries).toEqual([]);
});

test("the button offered on an unlabelled pull request names the strategy", async () => {
  const state = await run({});
  expect(state.checkRuns[0]?.actions).toEqual([
    { label: "Merge now", description: "Merge with a merge commit", identifier: "merge" },
  ]);
});

test("a configured commit title and message are rendered and sent", async () => {
  const state = await run(
    {
      configSource: `
version: 1
merge:
  commitTitle: "Merge {head} into {base} (#{number})"
  commitMessage: "{title}"
rules:
  - base: staging
    head: develop
    strategy: merge
  - base: "**"
    strategy: squash
`,
    },
    { labels: ["ready-to-merge"] },
  );

  expect(state.merges[0]?.input).toEqual({
    method: "merge",
    sha: "c0ffee",
    commitTitle: "Merge develop into staging (#12)",
    commitMessage: "Promote develop",
  });
});

test("a press of the button merges without the label", async () => {
  const state = await run({}, {}, PRESSED);
  expect(state.permissionQueries).toEqual(["maintainer"]);
  expect(state.merges).toEqual([
    {
      pullNumber: 12,
      // No commit title or message: the configuration names neither, so the
      // merge call carries neither and GitHub writes its own.
      input: { method: "merge", sha: "c0ffee" },
    },
  ]);
  expect(state.checkRuns.at(-1)).toMatchObject({
    conclusion: "success",
    title: "Merged by mergegate",
  });
});

test("a press that cannot merge yet says so and keeps the button", async () => {
  const state = await run({}, { otherChecks: ["pending"] }, PRESSED);
  expect(state.merges).toHaveLength(0);
  const check = state.checkRuns.at(-1);
  expect(check).toMatchObject({
    conclusion: "action_required",
    title: "Waiting for other checks",
  });
  // The press left nothing behind, so the check must not promise a merge.
  expect(check?.summary).toContain("Add the `ready-to-merge` label");
  expect(check?.summary).toContain("Merge now");
  expect(check?.actions).toHaveLength(1);
});

test("a labelled pull request that is not ready is the one mergegate comes back to", async () => {
  const state = await run({}, { labels: ["ready-to-merge"], otherChecks: ["pending"] });
  const check = state.checkRuns.at(-1);
  expect(check?.summary).toContain("mergegate merges as soon as that clears");
  // Nothing to press: the label already is the standing instruction.
  expect(check?.actions).toEqual([]);
});

test("a press from someone who cannot push is refused", async () => {
  const state = await run({ pushers: [] }, {}, PRESSED);
  expect(state.permissionQueries).toEqual(["maintainer"]);
  expect(state.merges).toHaveLength(0);
  expect(state.checkRuns[0]).toMatchObject({ title: "Merge commit required" });
});

test("a press belonging to a commit that is no longer the head is ignored", async () => {
  const state = await run(
    {},
    {},
    {
      mergeRequest: { headSha: "beef", actor: "maintainer" },
    },
  );
  // The permission is never even asked for: the press is not about this commit.
  expect(state.permissionQueries).toEqual([]);
  expect(state.merges).toHaveLength(0);
  expect(state.checkRuns[0]).toMatchObject({ title: "Merge commit required" });
});

const NO_ACTION_CONFIG = `
version: 1
merge:
  allowCheckAction: false
rules:
  - base: staging
    head: develop
    strategy: merge
`;

test("allowCheckAction: false takes the button away and stops honouring it", async () => {
  const state = await run({ configSource: NO_ACTION_CONFIG }, {}, PRESSED);
  expect(state.checkRuns[0]).toMatchObject({
    title: "Merge commit required",
    actions: [],
  });
  expect(state.permissionQueries).toEqual([]);
  expect(state.merges).toHaveLength(0);
});

test("a press that hits a permanent failure has no label to drop, so it keeps the button", async () => {
  const state = await run(
    { mergeOutcome: { ok: false, kind: "conflict", message: "Merge conflict" } },
    {},
    PRESSED,
  );
  expect(state.removedLabels).toEqual([]);
  expect(state.checkRuns.at(-1)).toMatchObject({
    title: "Cannot merge",
    actions: [
      { label: "Merge now", description: "Merge with a merge commit", identifier: "merge" },
    ],
  });
});

test("the label wins over the button, so the permission is never looked up", async () => {
  const state = await run({}, { labels: ["ready-to-merge"] }, PRESSED);
  expect(state.permissionQueries).toEqual([]);
  expect(state.merges).toHaveLength(1);
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

test("a refused API call fails the check run instead of leaving nothing", async () => {
  const pull = pullRequest();
  const { api, state } = createFakeGitHub({
    configSource: CONFIG,
    pullRequests: new Map([[pull.number, pull]]),
  });
  const refused = new GitHubApiError("Resource not accessible by integration", {
    status: 403,
    method: "POST",
    url: "/graphql",
  });
  const failing: GitHubApi = {
    ...api,
    getPullRequestState: async () => {
      throw refused;
    },
  };
  const { context } = createTestContext(failing);

  // The head only exists in the delivery: the pull request was never read.
  await evaluatePullRequest(context, failing, repo, pull.number, { headSha: "c0ffee" });

  expect(state.checkRuns).toHaveLength(1);
  expect(state.checkRuns[0]).toMatchObject({
    name: "mergegate",
    headSha: "c0ffee",
    conclusion: "failure",
    title: "mergegate is missing a permission",
  });
});

test("a refused API call with no head to report on is left to the delivery log", async () => {
  const pull = pullRequest();
  const { api, state } = createFakeGitHub({
    configSource: CONFIG,
    pullRequests: new Map([[pull.number, pull]]),
  });
  const failing: GitHubApi = {
    ...api,
    getPullRequestState: async () => {
      throw new GitHubApiError("Resource not accessible by integration", { status: 403 });
    },
  };
  const { context } = createTestContext(failing);

  await expect(evaluatePullRequest(context, failing, repo, pull.number)).rejects.toThrow(
    "Resource not accessible by integration",
  );
  expect(state.checkRuns).toHaveLength(0);
});

test("a failure after the pull request was read lands on the head GitHub reported", async () => {
  const pull = pullRequest({ base: "develop", head: "feature/login", headSha: "beefbeef" });
  const { api, state } = createFakeGitHub({
    configSource: CONFIG,
    pullRequests: new Map([[pull.number, pull]]),
  });
  let attempts = 0;
  const failing: GitHubApi = {
    ...api,
    upsertCheckRun: async (target, input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("the network went away");
      }
      await api.upsertCheckRun(target, input);
    },
  };
  const { context } = createTestContext(failing);

  // A stale head from the delivery must not win over what GitHub answered.
  await evaluatePullRequest(context, failing, repo, pull.number, { headSha: "stale" });

  expect(state.checkRuns).toHaveLength(1);
  expect(state.checkRuns[0]).toMatchObject({
    headSha: "beefbeef",
    conclusion: "failure",
    title: "mergegate could not evaluate this pull request",
  });
});

test("a branch that cannot be deleted does not undo a reported merge", async () => {
  const pull = pullRequest({ labels: ["ready-to-merge"] });
  const { api, state } = createFakeGitHub({
    configSource: `${CONFIG}\nmerge:\n  deleteBranchOnMerge: true\n`,
    pullRequests: new Map([[pull.number, pull]]),
  });
  const failing: GitHubApi = {
    ...api,
    deleteBranch: async () => {
      throw new GitHubApiError("Resource not accessible by integration", { status: 403 });
    },
  };
  const { context } = createTestContext(failing);

  await evaluatePullRequest(context, failing, repo, pull.number);

  expect(state.merges).toHaveLength(1);
  expect(state.checkRuns.at(-1)).toMatchObject({
    conclusion: "success",
    title: "Merged by mergegate",
  });
});
