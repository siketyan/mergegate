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
    includeReversed: true
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
    rule: {
      base: "staging",
      head: ["develop"],
      strategy: "merge",
      includeTransitive: false,
      includeReversed: false,
    },
  });
});

test("an intermediate branch reaches the rule its source would", () => {
  // A promotion that conflicts is opened from a branch off the base with the
  // source merged into it, so the pull request's head is not the source branch.
  const config = load(`
version: 1
rules:
  - base: staging
    head: [develop, "merge/develop-*"]
    strategy: merge
  - base: "**"
    strategy: squash
`);

  for (const head of ["develop", "merge/develop-to-staging", "merge/develop-20260826"]) {
    expect(decide(config, { base: "staging", head, isFork: false })).toMatchObject({
      kind: "assisted",
      strategy: "merge",
    });
  }

  // Still only for that base: the same branch elsewhere is an ordinary feature.
  expect(
    decide(config, { base: "develop", head: "merge/develop-to-staging", isFork: false }),
  ).toMatchObject({ kind: "manual", strategy: "squash" });
});

test("an intermediate branch is still refused by a forbidding rule", () => {
  const config = load(`
version: 1
rules:
  - base: production
    head: [staging, "merge/staging-*"]
    strategy: merge
  - base: production
    strategy: forbid
  - base: "**"
    strategy: squash
`);
  expect(
    decide(config, { base: "production", head: "merge/staging-x", isFork: false }),
  ).toMatchObject({ kind: "assisted", strategy: "merge" });
  // Not every merge/* branch: only the ones the rule lists.
  expect(
    decide(config, { base: "production", head: "merge/develop-x", isFork: false }),
  ).toMatchObject({ kind: "forbidden" });
});

test("a fork cannot reach an assisted rule through an intermediate branch name", () => {
  const config = load(`
version: 1
rules:
  - base: staging
    head: [develop, "merge/*"]
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(decide(config, { base: "staging", head: "merge/anything", isFork: true })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
});

const TRANSITIVE = load(`
version: 1
rules:
  - base: staging
    head: develop
    includeTransitive: true
    strategy: merge
  - base: "**"
    strategy: squash
`);

test("a rule can match on what the pull request carries, not its name", () => {
  const refs = { base: "staging", head: "resolve-the-conflicts", isFork: false };

  // The branch is named nothing in particular, but it brings develop with it.
  expect(decide(TRANSITIVE, { ...refs, carriedFrom: new Set(["develop"]) })).toMatchObject({
    kind: "assisted",
    strategy: "merge",
  });

  // The same branch carrying nothing from develop is an ordinary feature.
  expect(decide(TRANSITIVE, { ...refs, carriedFrom: new Set() })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
  expect(decide(TRANSITIVE, refs)).toMatchObject({ kind: "manual", strategy: "squash" });
});

test("carrying a branch means nothing without includeTransitive", () => {
  const config = load(`
version: 1
rules:
  - base: staging
    head: develop
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(
    decide(config, {
      base: "staging",
      head: "resolve-the-conflicts",
      isFork: false,
      carriedFrom: new Set(["develop"]),
    }),
  ).toMatchObject({ kind: "manual", strategy: "squash" });
});

test("the transitive check follows branches, not patterns", () => {
  const config = load(`
version: 1
rules:
  - base: staging
    head: ["release/*", develop]
    includeTransitive: true
    strategy: merge
  - base: "**"
    strategy: squash
`);
  // "release/*" names no branch, so nothing can be carried from it.
  expect(
    decide(config, {
      base: "staging",
      head: "anything",
      isFork: false,
      carriedFrom: new Set(["release/*"]),
    }),
  ).toMatchObject({ kind: "manual", strategy: "squash" });
  expect(
    decide(config, {
      base: "staging",
      head: "anything",
      isFork: false,
      carriedFrom: new Set(["develop"]),
    }),
  ).toMatchObject({ kind: "assisted", strategy: "merge" });
});

test("a fork cannot reach an assisted rule by carrying the source branch", () => {
  expect(
    decide(TRANSITIVE, {
      base: "staging",
      head: "anything",
      isFork: true,
      carriedFrom: new Set(["develop"]),
    }),
  ).toMatchObject({ kind: "manual", strategy: "squash" });
});

const REVERSED = load(`
version: 1
rules:
  - base: staging
    head: develop
    includeReversed: true
    strategy: merge
  - base: "**"
    strategy: squash
`);

test("one rule covers the promotion and the back merge", () => {
  // Written in the direction of the promotion, and the branches promote into
  // each other, so the same rule has to answer for staging -> develop.
  expect(decide(REVERSED, { base: "staging", head: "develop", isFork: false })).toMatchObject({
    kind: "assisted",
    strategy: "merge",
  });
  expect(decide(REVERSED, { base: "develop", head: "staging", isFork: false })).toMatchObject({
    kind: "assisted",
    strategy: "merge",
  });
});

test("the reversed direction is not a way into the rule from anywhere else", () => {
  // Only base and head swap places: another branch into develop is untouched,
  // and so is staging into a branch the rule never named.
  expect(decide(REVERSED, { base: "develop", head: "feature/x", isFork: false })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
  expect(decide(REVERSED, { base: "production", head: "staging", isFork: false })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
});

test("a back merge is not matched without includeReversed", () => {
  const config = load(`
version: 1
rules:
  - base: staging
    head: develop
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(decide(config, { base: "develop", head: "staging", isFork: false })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
});

test("every head is a base in the reversed direction", () => {
  const config = load(`
version: 1
rules:
  - base: staging
    head: [develop, "release/*"]
    includeReversed: true
    strategy: merge
  - base: "**"
    strategy: squash
`);
  for (const base of ["develop", "release/2026-08"]) {
    expect(decide(config, { base, head: "staging", isFork: false })).toMatchObject({
      kind: "assisted",
      strategy: "merge",
    });
  }
});

test("a forbidden pair is forbidden both ways", () => {
  const config = load(`
version: 1
rules:
  - base: production
    head: develop
    includeReversed: true
    strategy: forbid
  - base: "**"
    strategy: squash
`);
  expect(decide(config, { base: "production", head: "develop", isFork: false })).toMatchObject({
    kind: "forbidden",
  });
  expect(decide(config, { base: "develop", head: "production", isFork: false })).toMatchObject({
    kind: "forbidden",
  });
});

test("a back merge through an intermediate branch reaches the rule too", () => {
  // Both options together: the back merge conflicted, so it is opened from a
  // branch off develop with staging merged into it, named nothing in particular.
  const config = load(`
version: 1
rules:
  - base: staging
    head: develop
    includeTransitive: true
    includeReversed: true
    strategy: merge
  - base: "**"
    strategy: squash
`);
  expect(
    decide(config, {
      base: "develop",
      head: "resolve-the-conflicts",
      isFork: false,
      carriedFrom: new Set(["staging"]),
    }),
  ).toMatchObject({ kind: "assisted", strategy: "merge" });

  // The same branch into develop carrying nothing from staging is a feature.
  expect(
    decide(config, {
      base: "develop",
      head: "resolve-the-conflicts",
      isFork: false,
      carriedFrom: new Set(),
    }),
  ).toMatchObject({ kind: "manual", strategy: "squash" });
});

test("a fork cannot reach an assisted rule through the reversed direction", () => {
  expect(decide(REVERSED, { base: "develop", head: "staging", isFork: true })).toMatchObject({
    kind: "manual",
    strategy: "squash",
  });
});
