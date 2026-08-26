import { expect, test } from "vite-plus/test";
import { renderCheck } from "./render.ts";

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
  });
  expect(output.conclusion).toBe("action_required");
  expect(output.title).toBe("Merge commit required");
  expect(output.summary).toContain("ready-to-merge");
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
    title: "Merged by squashables",
  });
});

test("a forbidden pair names both branches and cannot be cleared", () => {
  expect(renderCheck({ kind: "forbidden", base: "production", head: "develop" })).toEqual({
    conclusion: "failure",
    title: "Pull requests into production from develop are not allowed",
    summary: expect.stringContaining(".github/squashables.yml"),
  });
});

test("an unreadable configuration fails closed and lists why", () => {
  const output = renderCheck({
    kind: "invalid-config",
    errors: ["version: expected 1", "rules[0].base: must be a non-empty branch pattern"],
  });
  expect(output.conclusion).toBe("failure");
  expect(output.title).toBe("Invalid .github/squashables.yml");
  expect(output.summary).toContain("rules[0].base");
});
