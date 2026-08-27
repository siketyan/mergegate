import * as v from "valibot";
import { isLiteral } from "../policy/glob.ts";

const branchPattern = v.pipe(v.string(), v.minLength(1, "must be a non-empty branch pattern"));

/**
 * One pattern or several. A promotion is often opened from an intermediate
 * branch — `develop` merged into a branch off `staging` so the conflicts can be
 * resolved there — and that branch has to reach the same rule its source would.
 */
const branchPatterns = v.pipe(
  v.union([branchPattern, v.pipe(v.array(branchPattern), v.minLength(1, "must list a pattern"))]),
  v.transform((value) => (typeof value === "string" ? [value] : value)),
);

/** A strategy a pull request can actually be merged with. */
export const strategySchema = v.picklist(["squash", "merge", "rebase"]);

/** What a rule may ask for, including refusing the pull request outright. */
const ruleStrategySchema = v.picklist(["squash", "merge", "rebase", "forbid"]);

export const ruleSchema = v.pipe(
  v.strictObject({
    base: branchPattern,
    head: v.optional(branchPatterns, "**"),
    strategy: ruleStrategySchema,
    /**
     * Match the rule by what the pull request carries, not only by the head's
     * name: any branch bringing commits from one of the head branches below,
     * however it came by them.
     */
    includeTransitive: v.optional(v.boolean(), false),
    /**
     * Apply the rule to the back merge as well: a pull request from `base` into
     * one of the heads below. Two branches that promote into each other are one
     * relationship, and writing it twice is how the two halves drift apart.
     */
    includeReversed: v.optional(v.boolean(), false),
  }),
  v.check(
    (rule) =>
      !rule.includeTransitive ||
      rule.head.some(isLiteral) ||
      // With includeReversed the base is a head as well, so it can be the
      // branch whose commits are looked for.
      (rule.includeReversed && isLiteral(rule.base)),
    "includeTransitive needs a head that names a branch, not only patterns",
  ),
  v.check(
    (rule) => !rule.includeReversed || rule.head.some((pattern) => pattern !== "**"),
    "includeReversed needs a head of its own: reversing the catch-all would match every pull request out of base",
  ),
);

export const configSchema = v.strictObject({
  version: v.literal(1),
  defaults: v.optional(
    v.strictObject({
      strategy: v.optional(strategySchema, "squash"),
    }),
    {},
  ),
  check: v.optional(
    v.strictObject({
      name: v.optional(v.pipe(v.string(), v.minLength(1)), "mergegate"),
    }),
    {},
  ),
  merge: v.optional(
    v.strictObject({
      label: v.optional(v.pipe(v.string(), v.minLength(1)), "ready-to-merge"),
      manual: v.optional(v.array(strategySchema), ["squash"]),
      requireApproval: v.optional(v.boolean(), true),
      requireChecks: v.optional(v.boolean(), true),
      requireUpToDate: v.optional(v.boolean(), false),
      allowForkHead: v.optional(v.boolean(), false),
      /**
       * Whether the check run offers a "Merge now" button. It is the label by
       * another name: the same gates apply, and mergegate verifies that whoever
       * pressed it can push before honouring it.
       */
      allowCheckAction: v.optional(v.boolean(), true),
      deleteBranchOnMerge: v.optional(v.boolean(), false),
      removeLabelOnFailure: v.optional(v.boolean(), true),
      /**
       * Unset means GitHub's own default for the merge method and the
       * repository's settings — mergegate sends no title or message at all
       * rather than inventing one.
       */
      commitTitle: v.optional(v.string()),
      commitMessage: v.optional(v.string()),
    }),
    {},
  ),
  rules: v.optional(v.array(ruleSchema), []),
});

export type Strategy = v.InferOutput<typeof strategySchema>;
export type Rule = v.InferOutput<typeof ruleSchema>;
export type Config = v.InferOutput<typeof configSchema>;
export type MergeSettings = Config["merge"];

/** The check run name used before the configuration could be read. */
export const FALLBACK_CHECK_NAME = "mergegate";

/** Where the configuration is read from, on the default branch. */
export const CONFIG_PATH = ".github/mergegate.yml";
