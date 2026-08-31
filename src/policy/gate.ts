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
  | "checks-unreadable"
  | "checks-refused"
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
  /** Conclusions of every check except the one mergegate owns. */
  readonly otherChecks: readonly CheckConclusion[];
  /**
   * `true` when GitHub reported more checks than mergegate was willing to page
   * through, so `otherChecks` is not the whole story.
   */
  readonly checksTruncated: boolean;
  /**
   * `true` when GitHub refused one of the checks rather than reporting it, so
   * mergegate does not know how it ended.
   */
  readonly checksRefused: boolean;
}

const PASSING: ReadonlySet<CheckConclusion> = new Set(["success", "neutral", "skipped"]);

/**
 * The label is not a sufficient condition. mergegate bypasses the ruleset, so
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
  if (settings.requireChecks) {
    // An unread check is not a passing one: a rollup mergegate could not read
    // to the end blocks rather than merging on the part it did see.
    if (input.checksRefused) {
      return { ready: false, reason: "checks-refused" };
    }
    if (input.checksTruncated) {
      return { ready: false, reason: "checks-unreadable" };
    }
    if (!input.otherChecks.every((check) => PASSING.has(check))) {
      return { ready: false, reason: "waiting-checks" };
    }
  }
  if (settings.requireUpToDate && input.behindBase) {
    return { ready: false, reason: "behind-base" };
  }
  return { ready: true };
}
