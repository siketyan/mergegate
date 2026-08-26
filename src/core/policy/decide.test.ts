import { describe, expect, test } from "vite-plus/test";
import type { Config } from "../config/schema.ts";
import { parseConfig } from "../config/parse.ts";
import { decide } from "./decide.ts";

function load(source: string): Config {
  const result = parseConfig(source);
  if (!result.ok) {
    throw new Error(`fixture configuration is invalid: ${result.errors.join(", ")}`);
  }
  return result.config;
}

/** The develop / staging / production example from the README, verbatim. */
const FLOW = load(`
version: 1

rules:
  - base: staging
    head: develop
    strategy: merge

  - base: production
    head: staging
    strategy: merge

  - base: production
    head: hotfix/*
    strategy: squash

  - base: production
    strategy: forbid

  - base: "**"
    strategy: squash
`);

/** The main / release example from the README, verbatim. */
const RELEASE = load(`
version: 1

rules:
  - base: release
    head: main
    strategy: merge

  - base: main
    head: release
    strategy: merge

  - base: release
    head: hotfix/*
    strategy: squash

  - base: "**"
    strategy: squash
`);

type Expectation =
  | { kind: "manual" | "assisted"; strategy: "squash" | "merge" | "rebase" }
  | { kind: "forbidden" };

const cases: readonly [
  name: string,
  config: Config,
  refs: { base: string; head: string; isFork?: boolean },
  expected: Expectation,
][] = [
  [
    "feature into develop is squashed by a human",
    FLOW,
    { base: "develop", head: "feature/login" },
    { kind: "manual", strategy: "squash" },
  ],
  [
    "develop into staging needs a merge commit",
    FLOW,
    { base: "staging", head: "develop" },
    { kind: "assisted", strategy: "merge" },
  ],
  [
    "staging into production needs a merge commit",
    FLOW,
    { base: "production", head: "staging" },
    { kind: "assisted", strategy: "merge" },
  ],
  [
    "a hotfix into production is squashed",
    FLOW,
    { base: "production", head: "hotfix/crash" },
    { kind: "manual", strategy: "squash" },
  ],
  [
    "anything else into production is refused",
    FLOW,
    { base: "production", head: "develop" },
    { kind: "forbidden" },
  ],
  [
    "a nested feature branch still matches **",
    FLOW,
    { base: "develop", head: "feature/a/b" },
    { kind: "manual", strategy: "squash" },
  ],

  [
    "feature into main is squashed",
    RELEASE,
    { base: "main", head: "feature/login" },
    { kind: "manual", strategy: "squash" },
  ],
  [
    "main into release needs a merge commit",
    RELEASE,
    { base: "release", head: "main" },
    { kind: "assisted", strategy: "merge" },
  ],
  [
    "the back-merge into main needs a merge commit",
    RELEASE,
    { base: "main", head: "release" },
    { kind: "assisted", strategy: "merge" },
  ],
  [
    "a hotfix into release is squashed",
    RELEASE,
    { base: "release", head: "hotfix/crash" },
    { kind: "manual", strategy: "squash" },
  ],

  // A fork can name its branch `develop`, so it must not reach an assisted rule.
  [
    "a fork cannot reach an assisted rule",
    FLOW,
    { base: "staging", head: "develop", isFork: true },
    { kind: "manual", strategy: "squash" },
  ],
  // ... but a forbidding rule is a restriction, so it still applies.
  [
    "a fork is still refused by a forbidding rule",
    FLOW,
    { base: "production", head: "develop", isFork: true },
    { kind: "forbidden" },
  ],
];

describe("decide", () => {
  for (const [name, config, refs, expected] of cases) {
    test(name, () => {
      const decision = decide(config, { isFork: false, ...refs });
      expect(decision.kind).toBe(expected.kind);
      if (expected.kind !== "forbidden" && decision.kind !== "forbidden") {
        expect(decision.strategy).toBe(expected.strategy);
      }
    });
  }
});

test("the first matching rule wins", () => {
  const config = load(`
version: 1
rules:
  - base: "**"
    strategy: squash
  - base: staging
    head: develop
    strategy: merge
`);
  // The catch-all is written first, so it shadows the specific rule below it.
  const decision = decide(config, { base: "staging", head: "develop", isFork: false });
  expect(decision).toMatchObject({ kind: "manual", strategy: "squash" });
});

test("a pull request that matches nothing falls back to the defaults", () => {
  const config = load(`
version: 1
defaults:
  strategy: merge
rules:
  - base: staging
    head: develop
    strategy: squash
`);
  const decision = decide(config, { base: "main", head: "feature/x", isFork: false });
  expect(decision).toMatchObject({ kind: "assisted", strategy: "merge" });
  expect(decision.match).toEqual({ source: "defaults" });
});

test("merge.manual decides who merges, not the strategy name", () => {
  const config = load(`
version: 1
merge:
  manual: [merge]
rules:
  - base: release
    head: main
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(decide(config, { base: "release", head: "main", isFork: false })).toMatchObject({
    kind: "manual",
    strategy: "merge",
  });
  expect(decide(config, { base: "main", head: "feature/x", isFork: false })).toMatchObject({
    kind: "assisted",
    strategy: "squash",
  });
});

test("allowForkHead lets a fork reach an assisted rule", () => {
  const config = load(`
version: 1
merge:
  allowForkHead: true
rules:
  - base: staging
    head: develop
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(decide(config, { base: "staging", head: "develop", isFork: true })).toMatchObject({
    kind: "assisted",
    strategy: "merge",
  });
});

test("the matched rule is reported back", () => {
  const decision = decide(FLOW, { base: "staging", head: "develop", isFork: false });
  expect(decision.match).toEqual({
    source: "rule",
    index: 0,
    rule: { base: "staging", head: "develop", strategy: "merge" },
  });
});
