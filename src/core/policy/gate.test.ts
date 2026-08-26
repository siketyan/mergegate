import { expect, test } from "vite-plus/test";
import { defaultConfig } from "../config/parse.ts";
import type { MergeSettings } from "../config/schema.ts";
import { evaluateGate, type GateInput } from "./gate.ts";

const settings: MergeSettings = defaultConfig().merge;

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    draft: false,
    mergeable: true,
    behindBase: false,
    reviewDecision: "APPROVED",
    otherChecks: ["success"],
    ...overrides,
  };
}

test("a fully green pull request is ready", () => {
  expect(evaluateGate(input(), settings)).toEqual({ ready: true });
});

test("a draft is never merged", () => {
  expect(evaluateGate(input({ draft: true }), settings)).toEqual({
    ready: false,
    reason: "draft",
  });
});

test("undetermined mergeability is not treated as mergeable", () => {
  expect(evaluateGate(input({ mergeable: null }), settings)).toEqual({
    ready: false,
    reason: "mergeability-unknown",
  });
});

test("a conflicting branch is not merged", () => {
  expect(evaluateGate(input({ mergeable: false }), settings)).toEqual({
    ready: false,
    reason: "conflict",
  });
});

test("requested changes are refused even when reviews are not required", () => {
  expect(
    evaluateGate(input({ reviewDecision: "CHANGES_REQUESTED" }), {
      ...settings,
      requireApproval: false,
    }),
  ).toEqual({ ready: false, reason: "changes-requested" });
});

test("a missing approval blocks while requireApproval is on", () => {
  expect(evaluateGate(input({ reviewDecision: "REVIEW_REQUIRED" }), settings)).toEqual({
    ready: false,
    reason: "waiting-review",
  });
  expect(
    evaluateGate(input({ reviewDecision: "REVIEW_REQUIRED" }), {
      ...settings,
      requireApproval: false,
    }),
  ).toEqual({ ready: true });
});

test("a repository without review rules reports no decision at all", () => {
  expect(evaluateGate(input({ reviewDecision: null }), settings)).toEqual({ ready: true });
});

test("pending and failing checks both block", () => {
  expect(evaluateGate(input({ otherChecks: ["success", "pending"] }), settings)).toEqual({
    ready: false,
    reason: "waiting-checks",
  });
  expect(evaluateGate(input({ otherChecks: ["failure"] }), settings)).toEqual({
    ready: false,
    reason: "waiting-checks",
  });
});

test("neutral and skipped checks count as passing", () => {
  expect(evaluateGate(input({ otherChecks: ["neutral", "skipped"] }), settings)).toEqual({
    ready: true,
  });
});

test("being behind the base only blocks when it is required", () => {
  expect(evaluateGate(input({ behindBase: true }), settings)).toEqual({ ready: true });
  expect(evaluateGate(input({ behindBase: true }), { ...settings, requireUpToDate: true })).toEqual(
    { ready: false, reason: "behind-base" },
  );
});
