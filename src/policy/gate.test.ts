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
    checksTruncated: false,
    checksRefused: false,
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

test("a rollup mergegate could not read to the end blocks the merge", () => {
  expect(evaluateGate(input({ checksTruncated: true }), settings)).toEqual({
    ready: false,
    reason: "checks-unreadable",
  });
});

test("an unreadable rollup does not matter when checks are not required", () => {
  expect(
    evaluateGate(input({ checksTruncated: true }), { ...settings, requireChecks: false }),
  ).toEqual({ ready: true });
});

test("a check GitHub refused blocks the merge", () => {
  // An unread check is not a passing one: the refused context comes back null
  // and would otherwise vanish from otherChecks entirely.
  expect(evaluateGate(input({ checksRefused: true }), settings)).toEqual({
    ready: false,
    reason: "checks-refused",
  });
});

test("a check GitHub refused stops mattering without requireChecks", () => {
  expect(
    evaluateGate(input({ checksRefused: true }), { ...settings, requireChecks: false }),
  ).toEqual({ ready: true });
});
