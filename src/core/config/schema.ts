import * as v from "valibot";

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
export const ruleStrategySchema = v.picklist(["squash", "merge", "rebase", "forbid"]);

export const ruleSchema = v.strictObject({
  base: branchPattern,
  head: v.optional(branchPatterns, "**"),
  strategy: ruleStrategySchema,
});

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
      deleteBranchOnMerge: v.optional(v.boolean(), false),
      removeLabelOnFailure: v.optional(v.boolean(), true),
      commitTitle: v.optional(v.string(), "Merge {head} into {base} (#{number})"),
      commitMessage: v.optional(v.string(), ""),
    }),
    {},
  ),
  rules: v.optional(v.array(ruleSchema), []),
});

export type Strategy = v.InferOutput<typeof strategySchema>;
export type RuleStrategy = v.InferOutput<typeof ruleStrategySchema>;
export type Rule = v.InferOutput<typeof ruleSchema>;
export type Config = v.InferOutput<typeof configSchema>;
export type MergeSettings = Config["merge"];

/** The check run name used before the configuration could be read. */
export const FALLBACK_CHECK_NAME = "mergegate";

/** Where the configuration is read from, on the default branch. */
export const CONFIG_PATH = ".github/mergegate.yml";
