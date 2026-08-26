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

test("no state offers a button once mergegate is going to act on its own", () => {
  // A labelled pull request needs no button, and neither does a settled one. A
  // check run is only ever updated with the whole list, so this clears them.
  const states = [
    { kind: "manual", strategy: "squash" },
    {
      kind: "waiting",
      reason: "waiting-checks",
      label: "ready-to-merge",
      strategy: "merge",
      armed: true,
      offerMerge: false,
    },
    { kind: "merged", strategy: "merge" },
    { kind: "merge-failed", message: "Merge conflict", strategy: "merge", offerMerge: false },
    { kind: "forbidden", base: "production", head: "develop" },
    { kind: "invalid-config", errors: ["version: expected 1"] },
  ] as const;

  for (const state of states) {
    expect(renderCheck(state).actions).toEqual([]);
  }
});

test("a merge that failed with no label behind it keeps a way to retry", () => {
  const output = renderCheck({
    kind: "merge-failed",
    message: "Merge conflict",
    strategy: "merge",
    offerMerge: true,
  });
  expect(output.title).toBe("Cannot merge");
  expect(output.actions).toHaveLength(1);
});

test("every gate reason blocks the merge", () => {
  const reasons = [
    ["waiting-checks", "Waiting for other checks", true],
    ["waiting-review", "Waiting for review approval", true],
    ["conflict", "Cannot merge: conflicts with base", true],
    ["changes-requested", "Cannot merge: changes requested", true],
    ["behind-base", "Waiting for the branch to be up to date", true],
    ["draft", "Waiting for the pull request to be ready", true],
    ["mergeability-unknown", "Waiting for GitHub to compute mergeability", false],
    ["checks-unreadable", "Cannot read every check on this commit", false],
  ] as const;

  for (const [reason, title, resumes] of reasons) {
    const output = renderCheck({
      kind: "waiting",
      reason,
      label: "ready-to-merge",
      strategy: "merge",
      armed: true,
      offerMerge: false,
    });
    expect(output.conclusion).toBe("action_required");
    expect(output.title).toBe(title);
    // Only where an ordinary event brings mergegate back may the check say so.
    expect(output.summary.includes("mergegate merges as soon as that clears")).toBe(resumes);
  }
});

test("a wait mergegate will not come back to says so instead", () => {
  // The backoff is spent and no further event is guaranteed, so the label being
  // on is not the same promise it is everywhere else.
  const output = renderCheck({
    kind: "waiting",
    reason: "mergeability-unknown",
    label: "ready-to-merge",
    strategy: "merge",
    armed: true,
    offerMerge: false,
  });
  expect(output.title).toBe("Waiting for GitHub to compute mergeability");
  expect(output.summary).not.toContain("mergegate merges as soon as that clears");
  expect(output.summary).toContain("Push to the branch or re-add the `ready-to-merge` label");
});

test("an unarmed wait mergegate will not come back to offers the press as the retry", () => {
  const output = renderCheck({
    kind: "waiting",
    reason: "mergeability-unknown",
    label: "ready-to-merge",
    strategy: "merge",
    armed: false,
    offerMerge: true,
  });
  expect(output.summary).toContain("press **Merge now** again");
  expect(output.actions).toHaveLength(1);
});

test("a wait no press could ever clear keeps no button and adds no advice", () => {
  const output = renderCheck({
    kind: "waiting",
    reason: "checks-unreadable",
    label: "ready-to-merge",
    strategy: "merge",
    armed: false,
    offerMerge: true,
  });
  expect(output.title).toBe("Cannot read every check on this commit");
  // The summary already names the only thing that works.
  expect(output.summary).toContain("Merge this pull request by hand");
  expect(output.summary).not.toContain("Merge now");
  expect(output.summary).not.toContain("ready-to-merge");
  expect(output.actions).toEqual([]);
});

test("a wait nobody armed promises nothing and keeps the button", () => {
  const output = renderCheck({
    kind: "waiting",
    reason: "waiting-checks",
    label: "ready-to-merge",
    strategy: "merge",
    armed: false,
    offerMerge: true,
  });
  expect(output.summary).not.toContain("mergegate merges as soon as that clears");
  expect(output.summary).toContain("Add the `ready-to-merge` label");
  expect(output.summary).toContain("press **Merge now** again");
  expect(output.actions).toHaveLength(1);
});

test("a wait nobody armed still points at the label when the button is off", () => {
  const output = renderCheck({
    kind: "waiting",
    reason: "waiting-checks",
    label: "ready-to-merge",
    strategy: "merge",
    armed: false,
    offerMerge: false,
  });
  expect(output.summary).toContain("Add the `ready-to-merge` label");
  expect(output.summary).not.toContain("Merge now");
  expect(output.actions).toEqual([]);
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
