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

/** One check on the head commit, as the gate sees it. */
export interface OtherCheck {
  readonly conclusion: CheckConclusion;
  /**
   * Whether the branch protection or a ruleset makes this check required for
   * the pull request. Only required checks gate the merge, as they do for
   * GitHub's own merge button.
   */
  readonly required: boolean;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/** Why an assisted merge is not happening yet. */
export type GateReason =
  | "draft"
  | "mergeability-unknown"
  | "conflict"
  | "waiting-checks"
  | "checks-unreadable"
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
  /** Every check except the one mergegate owns. */
  readonly otherChecks: readonly OtherCheck[];
  /**
   * `true` when GitHub reported more checks than mergegate was willing to page
   * through, so `otherChecks` is not the whole story.
   */
  readonly checksTruncated: boolean;
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
    // to the end blocks rather than merging on the part it did see, since the
    // unread part may hold a required check.
    if (input.checksTruncated) {
      return { ready: false, reason: "checks-unreadable" };
    }
    // A check that is not required does not block GitHub's merge button, so it
    // does not block an assisted merge either.
    if (!input.otherChecks.every((check) => !check.required || PASSING.has(check.conclusion))) {
      return { ready: false, reason: "waiting-checks" };
    }
  }
  if (settings.requireUpToDate && input.behindBase) {
    return { ready: false, reason: "behind-base" };
  }
  return { ready: true };
}
