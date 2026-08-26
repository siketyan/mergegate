import type { MergeSettings } from "../config/schema.ts";

/** Conclusions GitHub reports for a check run or commit status. */
export type CheckConclusion =
  | "success"
  | "neutral"
  | "skipped"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "stale"
  | "pending";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/** Why an assisted merge is not happening yet. */
export type GateReason =
  | "draft"
  | "mergeability-unknown"
  | "conflict"
  | "waiting-checks"
  | "waiting-review"
  | "changes-requested"
  | "behind-base";

export type GateResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: GateReason };

export interface GateInput {
  readonly draft: boolean;
  /** `null` while GitHub is still computing it. */
  readonly mergeable: boolean | null;
  readonly behindBase: boolean;
  readonly reviewDecision: ReviewDecision;
  /** Conclusions of every check except the one squashables owns. */
  readonly otherChecks: readonly CheckConclusion[];
}

const PASSING: ReadonlySet<CheckConclusion> = new Set(["success", "neutral", "skipped"]);

/**
 * The label is not a sufficient condition. squashables bypasses the ruleset, so
 * GitHub's own gates do not apply and this function has to stand in for them.
 */
export function evaluateGate(input: GateInput, settings: MergeSettings): GateResult {
  if (input.draft) {
    return { ready: false, reason: "draft" };
  }
  if (input.mergeable === null) {
    return { ready: false, reason: "mergeability-unknown" };
  }
  if (!input.mergeable) {
    return { ready: false, reason: "conflict" };
  }
  if (input.reviewDecision === "CHANGES_REQUESTED") {
    return { ready: false, reason: "changes-requested" };
  }
  if (settings.requireApproval && input.reviewDecision === "REVIEW_REQUIRED") {
    return { ready: false, reason: "waiting-review" };
  }
  if (settings.requireChecks && !input.otherChecks.every((check) => PASSING.has(check))) {
    return { ready: false, reason: "waiting-checks" };
  }
  if (settings.requireUpToDate && input.behindBase) {
    return { ready: false, reason: "behind-base" };
  }
  return { ready: true };
}
