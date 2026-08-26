import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import {
  createFakeGitHub,
  createTestContext,
  pullRequest,
  testEnv,
} from "../../test/fake-github.ts";
import type { Cache } from "../ports.ts";
import { handleDelivery } from "./index.ts";

async function fixture(name: string): Promise<Record<string, unknown>> {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const HEAD_SHA = "c0ffee0000000000000000000000000000000000";

const ASSISTED = `
version: 1
rules:
  - base: staging
    head: develop
    strategy: merge
`;

function fake(overrides: Partial<Parameters<typeof createFakeGitHub>[0]> = {}) {
  const pull = pullRequest({ headSha: HEAD_SHA });
  return createFakeGitHub({
    configSource: "version: 1\n",
    pullRequests: new Map([[pull.number, pull]]),
    ...overrides,
  });
}

test("an opened pull request is evaluated", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  await handleDelivery(context, "pull_request", await fixture("pull_request.opened"));
  expect(state.checkRuns).toHaveLength(1);
});

test("an action that cannot change the decision is ignored", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  const payload = { ...(await fixture("pull_request.opened")), action: "assigned" };
  await handleDelivery(context, "pull_request", payload);
  expect(state.checkRuns).toHaveLength(0);
});

test("our own check run never triggers another one", async () => {
  const { api, state } = fake();
  // testEnv.appId is 1234, which is the app in the fixture.
  const { context } = createTestContext(api);
  await handleDelivery(context, "check_run", await fixture("check_run.completed"));
  expect(state.checkRuns).toHaveLength(0);
});

test("someone else's check run re-evaluates the pull requests on that commit", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api, { env: { ...testEnv, appId: "9999" } });
  await handleDelivery(context, "check_run", await fixture("check_run.completed"));
  expect(state.checkRuns).toHaveLength(1);
});

test("a push to the default branch drops the cached configuration", async () => {
  const { api } = fake();
  const deleted: string[] = [];
  const cache: Cache = {
    get: async () => null,
    put: async () => {},
    delete: async (key) => {
      deleted.push(key);
    },
  };
  const { context } = createTestContext(api, { cache });

  await handleDelivery(context, "push", await fixture("push"));
  expect(deleted).toEqual(["config:siketyan/mergegate"]);

  const onABranch = { ...(await fixture("push")), ref: "refs/heads/feature/x" };
  await handleDelivery(context, "push", onABranch);
  expect(deleted).toHaveLength(1);
});

test("the re-run button on our own check run re-evaluates the pull request", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  await handleDelivery(context, "check_run", await fixture("check_run.rerequested"));
  expect(state.checkRuns).toHaveLength(1);
  // The payload named the pull request, so no lookup by SHA was needed.
  expect(state.ownCheckNames).toEqual(["mergegate"]);
});

test("a re-run of somebody else's check run is not ours to answer", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api, { env: { ...testEnv, appId: "9999" } });
  await handleDelivery(context, "check_run", await fixture("check_run.rerequested"));
  expect(state.checkRuns).toHaveLength(0);
});

test("re-run all checks re-evaluates our own suite", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  await handleDelivery(context, "check_suite", await fixture("check_suite.rerequested"));
  expect(state.checkRuns).toHaveLength(1);
});

test("a suite of ours completing still never triggers another check run", async () => {
  const { api, state } = fake();
  const payload = { ...(await fixture("check_suite.rerequested")), action: "completed" };
  const { context } = createTestContext(api);
  await handleDelivery(context, "check_suite", payload);
  expect(state.checkRuns).toHaveLength(0);
});

test("the merge button merges the pull request it was rendered on", async () => {
  const { api, state } = fake({ configSource: ASSISTED });
  const { context } = createTestContext(api);
  await handleDelivery(context, "check_run", await fixture("check_run.requested_action"));
  expect(state.permissionQueries).toEqual(["maintainer"]);
  expect(state.merges).toMatchObject([{ pullNumber: 12, input: { sha: HEAD_SHA } }]);
});

test("a commit heading several pull requests merges none of them", async () => {
  const first = pullRequest({ number: 12, headSha: HEAD_SHA });
  const second = pullRequest({ number: 13, headSha: HEAD_SHA });
  const { api, state } = createFakeGitHub({
    configSource: ASSISTED,
    pullRequests: new Map([
      [first.number, first],
      [second.number, second],
    ]),
  });
  const { context } = createTestContext(api);
  const payload = await fixture("check_run.requested_action");
  // The press names a commit, not one of the two pull requests on it.
  payload.check_run = {
    ...(payload.check_run as Record<string, unknown>),
    pull_requests: [{ number: 12 }, { number: 13 }],
  };

  await handleDelivery(context, "check_run", payload);
  expect(state.merges).toHaveLength(0);
  expect(state.permissionQueries).toEqual([]);
  expect(state.checkRuns).toHaveLength(2);
});

test("a button mergegate does not offer is ignored", async () => {
  const { api, state } = fake({ configSource: ASSISTED });
  const { context } = createTestContext(api);
  const payload = {
    ...(await fixture("check_run.requested_action")),
    requested_action: { identifier: "something-else" },
  };
  await handleDelivery(context, "check_run", payload);
  expect(state.merges).toHaveLength(0);
  expect(state.checkRuns).toHaveLength(0);
});

test("a check_run action mergegate has no use for is ignored", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  const payload = { ...(await fixture("check_run.rerequested")), action: "created" };
  await handleDelivery(context, "check_run", payload);
  expect(state.checkRuns).toHaveLength(0);
});

test("an unknown event is ignored", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  await handleDelivery(context, "ping", { zen: "Non-blocking is better than blocking." });
  expect(state.checkRuns).toHaveLength(0);
});
