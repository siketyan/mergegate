import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import {
  createFakeGitHub,
  createTestContext,
  pullRequest,
  testEnv,
} from "../../../test/fake-github.ts";
import type { Cache } from "../ports.ts";
import { handleDelivery } from "./index.ts";

async function fixture(name: string): Promise<Record<string, unknown>> {
  const path = fileURLToPath(new URL(`../../../test/fixtures/${name}.json`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function fake() {
  const pull = pullRequest();
  return createFakeGitHub({
    configSource: "version: 1\n",
    pullRequests: new Map([[pull.number, pull]]),
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
  const { context } = createTestContext(api, { appId: testEnv.appId });
  await handleDelivery(context, "check_run", await fixture("check_run.completed"));
  expect(state.checkRuns).toHaveLength(0);
});

test("someone else's check run re-evaluates the pull requests on that commit", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api, { appId: "9999" });
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
  expect(deleted).toEqual(["config:siketyan/squashables"]);

  const onABranch = { ...(await fixture("push")), ref: "refs/heads/feature/x" };
  await handleDelivery(context, "push", onABranch);
  expect(deleted).toHaveLength(1);
});

test("an unknown event is ignored", async () => {
  const { api, state } = fake();
  const { context } = createTestContext(api);
  await handleDelivery(context, "ping", { zen: "Non-blocking is better than blocking." });
  expect(state.checkRuns).toHaveLength(0);
});
