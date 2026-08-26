import type { Rule, Strategy } from "../config/schema.ts";

/** Which rule produced a decision, for the check run output. */
export type RuleMatch =
  | { readonly source: "rule"; readonly index: number; readonly rule: Rule }
  | { readonly source: "defaults" };

/**
 * What a pull request is allowed to do.
 *
 * - `manual`: a human merges it from the GitHub UI (the check passes).
 * - `assisted`: mergegate merges it once the label is added (the check fails
 *   until then, so the ruleset blocks everyone else).
 * - `forbidden`: nobody may merge it.
 */
export type Decision =
  | { readonly kind: "manual"; readonly strategy: Strategy; readonly match: RuleMatch }
  | { readonly kind: "assisted"; readonly strategy: Strategy; readonly match: RuleMatch }
  | { readonly kind: "forbidden"; readonly match: RuleMatch };

/** The only pull request facts a decision depends on. */
export interface PullRequestRefs {
  readonly base: string;
  readonly head: string;
  readonly isFork: boolean;
  /**
   * Branches whose commits this pull request brings into the base, resolved
   * before the decision so that the policy stays a pure function. Only the
   * literal head branches of `includeTransitive` rules are ever looked up.
   */
  readonly carriedFrom?: ReadonlySet<string>;
}
