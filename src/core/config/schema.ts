import { z } from "zod";
import { isValidPattern } from "../policy/glob.ts";

const branchPattern = z
  .string()
  .refine(isValidPattern, { message: "must be a non-empty branch pattern" });

/** A strategy a pull request can actually be merged with. */
export const strategySchema = z.enum(["squash", "merge", "rebase"]);

/** What a rule may ask for, including refusing the pull request outright. */
export const ruleStrategySchema = z.enum(["squash", "merge", "rebase", "forbid"]);

export const ruleSchema = z.strictObject({
  base: branchPattern,
  head: branchPattern.prefault("**"),
  strategy: ruleStrategySchema,
});

export const configSchema = z.strictObject({
  version: z.literal(1),
  defaults: z
    .strictObject({
      strategy: strategySchema.prefault("squash"),
    })
    .prefault({}),
  check: z
    .strictObject({
      name: z.string().min(1).prefault("squashables"),
    })
    .prefault({}),
  merge: z
    .strictObject({
      label: z.string().min(1).prefault("ready-to-merge"),
      manual: z.array(strategySchema).prefault(["squash"]),
      requireApproval: z.boolean().prefault(true),
      requireChecks: z.boolean().prefault(true),
      requireUpToDate: z.boolean().prefault(false),
      allowForkHead: z.boolean().prefault(false),
      deleteBranchOnMerge: z.boolean().prefault(false),
      removeLabelOnFailure: z.boolean().prefault(true),
      commitTitle: z.string().prefault("Merge {head} into {base} (#{number})"),
      commitMessage: z.string().prefault(""),
    })
    .prefault({}),
  rules: z.array(ruleSchema).prefault([]),
});

export type Strategy = z.output<typeof strategySchema>;
export type RuleStrategy = z.output<typeof ruleStrategySchema>;
export type Rule = z.output<typeof ruleSchema>;
export type Config = z.output<typeof configSchema>;
export type MergeSettings = Config["merge"];

/** The check run name used before the configuration could be read. */
export const FALLBACK_CHECK_NAME = "squashables";

/** Where the configuration is read from, on the default branch. */
export const CONFIG_PATH = ".github/squashables.yml";
