import { expect, test } from "vite-plus/test";
import { MERGE_ACTION_IDENTIFIER, renderCheck } from "./render.ts";

test("a squash pull request passes", () => {
  expect(renderCheck({ kind: "manual", strategy: "squash" })).toMatchObject({
    conclusion: "success",
    title: "Squash merge",
  });
});

test("an unlabelled assisted pull request asks for the label", () => {
  const output = renderCheck({
    kind: "awaiting-label",
    strategy: "merge",
    label: "ready-to-merge",
    offerMerge: false,
  });
  expect(output.conclusion).toBe("action_required");
  expect(output.title).toBe("Merge commit required");
  expect(output.summary).toContain("ready-to-merge");
  expect(output.actions).toEqual([]);
  expect(output.summary).not.toContain("Merge now");
});

test("the button is offered alongside the label when it is enabled", () => {
  const output = renderCheck({
    kind: "awaiting-label",
    strategy: "merge",
    label: "ready-to-merge",
    offerMerge: true,
  });
  expect(output.summary).toContain("Merge now");
  expect(output.actions).toEqual([
    { label: "Merge now", description: "Merge with a merge commit", identifier: "merge" },
  ]);
});

test("a button stays inside the sizes GitHub accepts", () => {
  for (const strategy of ["squash", "merge", "rebase"] as const) {
    const [action] = renderCheck({
      kind: "awaiting-label",
      strategy,
      label: "ready-to-merge",
      offerMerge: true,
    }).actions;
    expect(action).toBeDefined();
    expect(action?.label.length).toBeLessThanOrEqual(20);
    expect(action?.description.length).toBeLessThanOrEqual(40);
    expect(action?.identifier.length).toBeLessThanOrEqual(20);
  }
});

test("no other state offers a button", () => {
  // Once the merge is armed there is nothing left for a human to press, and a
  // check run is only ever updated with the whole list.
  const states = [
    { kind: "manual", strategy: "squash" },
    { kind: "waiting", reason: "waiting-checks", label: "ready-to-merge" },
    { kind: "merged", strategy: "merge" },
    { kind: "merge-failed", message: "Merge conflict" },
    { kind: "forbidden", base: "production", head: "develop" },
    { kind: "invalid-config", errors: ["version: expected 1"] },
  ] as const;

  for (const state of states) {
    expect(renderCheck(state).actions).toEqual([]);
  }
});

test("every gate reason blocks the merge", () => {
  const reasons = [
    ["waiting-checks", "Waiting for other checks"],
    ["waiting-review", "Waiting for review approval"],
    ["conflict", "Cannot merge: conflicts with base"],
    ["changes-requested", "Cannot merge: changes requested"],
    ["behind-base", "Waiting for the branch to be up to date"],
    ["draft", "Waiting for the pull request to be ready"],
    ["mergeability-unknown", "Waiting for GitHub to compute mergeability"],
  ] as const;

  for (const [reason, title] of reasons) {
    const output = renderCheck({ kind: "waiting", reason, label: "ready-to-merge" });
    expect(output.conclusion).toBe("action_required");
    expect(output.title).toBe(title);
  }
});

test("a merged pull request ends green so the history carries no red X", () => {
  expect(renderCheck({ kind: "merged", strategy: "merge" })).toMatchObject({
    conclusion: "success",
    title: "Merged by mergegate",
  });
});

test("a forbidden pair names both branches and cannot be cleared", () => {
  expect(renderCheck({ kind: "forbidden", base: "production", head: "develop" })).toEqual({
    conclusion: "failure",
    title: "Pull requests into production from develop are not allowed",
    summary: expect.stringContaining(".github/mergegate.yml"),
    actions: [],
  });
});

test("an unreadable configuration fails closed and lists why", () => {
  const output = renderCheck({
    kind: "invalid-config",
    errors: ["version: expected 1", "rules[0].base: must be a non-empty branch pattern"],
  });
  expect(output.conclusion).toBe("failure");
  expect(output.title).toBe("Invalid .github/mergegate.yml");
  expect(output.summary).toContain("rules[0].base");
});

test("the identifier the webhook is matched against is the one on the button", () => {
  const [action] = renderCheck({
    kind: "awaiting-label",
    strategy: "merge",
    label: "ready-to-merge",
    offerMerge: true,
  }).actions;
  expect(action?.identifier).toBe(MERGE_ACTION_IDENTIFIER);
});
