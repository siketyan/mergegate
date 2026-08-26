import { describe, expect, test } from "vite-plus/test";
import { matchesPattern } from "./glob.ts";

describe("matchesPattern", () => {
  const cases: readonly [pattern: string, branch: string, expected: boolean][] = [
    ["develop", "develop", true],
    ["develop", "develop2", false],
    ["develop", "feature/develop", false],
    ["hotfix/*", "hotfix/crash", true],
    ["hotfix/*", "hotfix/deep/crash", false],
    ["**", "develop", true],
    ["**", "feature/a/b/c", true],
    ["feature/**", "feature/a/b", true],
    ["feature/**", "feature", false],
    ["release-?", "release-1", true],
    ["release-?", "release-12", false],
    // Regexp metacharacters in a branch name stay literal.
    ["release+1", "release+1", true],
    ["release+1", "releasee1", false],
    ["v1.0", "v1x0", false],
  ];

  for (const [pattern, branch, expected] of cases) {
    test(`${pattern} vs ${branch}`, () => {
      expect(matchesPattern(pattern, branch)).toBe(expected);
    });
  }
});
