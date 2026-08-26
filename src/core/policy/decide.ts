import type { Config, Rule, Strategy } from "../config/schema.ts";
import { isLiteral, matchesPattern } from "./glob.ts";
import type { Decision, PullRequestRefs, RuleMatch } from "./types.ts";

function isManual(config: Config, strategy: Strategy): boolean {
  return config.merge.manual.includes(strategy);
}

/**
 * A fork can name its branch anything, so a fork head must not be able to reach
 * a rule that hands the merge to the app. Forbidding rules still apply: they are
 * a restriction, not a privilege.
 */
function reachableFromFork(config: Config, rule: Rule): boolean {
  return rule.strategy === "forbid" || isManual(config, rule.strategy);
}

function matches(config: Config, rule: Rule, refs: PullRequestRefs): boolean {
  if (refs.isFork && !config.merge.allowForkHead && !reachableFromFork(config, rule)) {
    return false;
  }
  if (!matchesPattern(rule.base, refs.base)) {
    return false;
  }
  if (rule.head.some((pattern) => matchesPattern(pattern, refs.head))) {
    return true;
  }
  // A promotion that had to go through an intermediate branch does not carry the
  // source branch's name, so the rule can be told to look at what the pull
  // request brings with it instead.
  const carriedFrom = refs.carriedFrom;
  return (
    rule.includeTransitive === true &&
    carriedFrom !== undefined &&
    rule.head.some((pattern) => isLiteral(pattern) && carriedFrom.has(pattern))
  );
}

function decideStrategy(config: Config, strategy: Strategy, match: RuleMatch): Decision {
  return isManual(config, strategy)
    ? { kind: "manual", strategy, match }
    : { kind: "assisted", strategy, match };
}

/**
 * The heart of the app: the first rule that matches wins, in the order written
 * in the configuration file. When nothing matches, `defaults.strategy` applies.
 */
export function decide(config: Config, refs: PullRequestRefs): Decision {
  for (const [index, rule] of config.rules.entries()) {
    if (!matches(config, rule, refs)) {
      continue;
    }
    const match: RuleMatch = { source: "rule", index, rule };
    return rule.strategy === "forbid"
      ? { kind: "forbidden", match }
      : decideStrategy(config, rule.strategy, match);
  }

  return decideStrategy(config, config.defaults.strategy, { source: "defaults" });
}
