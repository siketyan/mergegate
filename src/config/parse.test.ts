import { expect, test } from "vite-plus/test";
import { defaultConfig, parseConfig } from "./parse.ts";

function errorsOf(source: string): readonly string[] {
  const result = parseConfig(source);
  if (result.ok) {
    throw new Error("expected the configuration to be rejected");
  }
  return result.errors;
}

test("a minimal file gets every default", () => {
  const result = parseConfig("version: 1\n");
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) {
    return;
  }
  expect(result.config).toEqual({
    version: 1,
    defaults: { strategy: "squash" },
    check: { name: "mergegate" },
    merge: {
      label: "ready-to-merge",
      manual: ["squash"],
      requireApproval: true,
      requireChecks: true,
      requireUpToDate: false,
      allowForkHead: false,
      allowCheckAction: true,
      deleteBranchOnMerge: false,
      removeLabelOnFailure: true,
      // No commitTitle and no commitMessage: unset means GitHub's own default.
    },
    rules: [],
  });
});

test("a repository with no configuration file behaves like a minimal one", () => {
  const result = parseConfig("version: 1\n");
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(defaultConfig()).toEqual(result.config);
  }
});

test("head defaults to matching every branch", () => {
  const result = parseConfig("version: 1\nrules:\n  - base: staging\n    strategy: merge\n");
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(result.config.rules[0]).toEqual({
      base: "staging",
      head: ["**"],
      strategy: "merge",
      includeTransitive: false,
      includeReversed: false,
    });
  }
});

test("head accepts several patterns, and one is normalised to a list", () => {
  const result = parseConfig(`
version: 1
rules:
  - base: staging
    head: [develop, "merge/develop-*"]
    strategy: merge
  - base: production
    head: staging
    strategy: merge
`);
  expect(result).toMatchObject({ ok: true });
  if (result.ok) {
    expect(result.config.rules[0]?.head).toEqual(["develop", "merge/develop-*"]);
    expect(result.config.rules[1]?.head).toEqual(["staging"]);
  }
});

test("includeTransitive defaults to off and needs a branch to follow", () => {
  const ok = parseConfig(`
version: 1
rules:
  - base: staging
    head: [develop, "merge/*"]
    includeTransitive: true
    strategy: merge
`);
  expect(ok).toMatchObject({ ok: true });
  if (ok.ok) {
    expect(ok.config.rules[0]?.includeTransitive).toBe(true);
  }

  expect(parseConfig("version: 1\nrules:\n  - base: staging\n    strategy: merge\n")).toMatchObject(
    { ok: true },
  );

  // Only patterns: there is no branch whose commits could be followed.
  expect(
    errorsOf(`
version: 1
rules:
  - base: staging
    head: "merge/*"
    includeTransitive: true
    strategy: merge
`).join(" "),
  ).toContain("includeTransitive");
});

test("includeReversed defaults to off and needs a head of its own", () => {
  const ok = parseConfig(`
version: 1
rules:
  - base: staging
    head: develop
    includeReversed: true
    strategy: merge
`);
  expect(ok).toMatchObject({ ok: true });
  if (ok.ok) {
    expect(ok.config.rules[0]?.includeReversed).toBe(true);
  }

  // Reversing the catch-all would quietly match every pull request out of the
  // base, which is never what writing one rule for a pair of branches meant.
  expect(
    errorsOf(
      "version: 1\nrules:\n  - base: staging\n    includeReversed: true\n    strategy: merge\n",
    ).join(" "),
  ).toContain("includeReversed");
  expect(
    errorsOf(`
version: 1
rules:
  - base: staging
    head: "**"
    includeReversed: true
    strategy: merge
`).join(" "),
  ).toContain("includeReversed");
});

test("the reversed direction gives includeTransitive a branch to follow", () => {
  // The base is a head in the reversed direction, so a literal base is enough
  // even when every head is a pattern.
  expect(
    parseConfig(`
version: 1
rules:
  - base: staging
    head: "release/*"
    includeTransitive: true
    includeReversed: true
    strategy: merge
`),
  ).toMatchObject({ ok: true });

  expect(
    errorsOf(`
version: 1
rules:
  - base: "staging/*"
    head: "release/*"
    includeTransitive: true
    includeReversed: true
    strategy: merge
`).join(" "),
  ).toContain("includeTransitive");
});

test("an empty list of head patterns is rejected", () => {
  // It would match nothing, which is a rule that silently does not apply.
  expect(
    errorsOf("version: 1\nrules:\n  - base: staging\n    head: []\n    strategy: merge\n"),
  ).not.toHaveLength(0);
});

test("a missing version is rejected", () => {
  expect(errorsOf("rules: []\n").join(" ")).toContain("version");
});

test("a future version is rejected", () => {
  expect(errorsOf("version: 2\n").join(" ")).toContain("version");
});

test("unknown keys are rejected rather than ignored", () => {
  // The offending key is named, so a typo is obvious from the check run.
  expect(errorsOf("version: 1\nstrategy: squash\n").join(" ")).toContain("strategy");
  expect(
    errorsOf("version: 1\nrules:\n  - base: main\n    strategy: squash\n    squash: true\n").join(
      " ",
    ),
  ).toContain("squash");
});

test("an unknown strategy is rejected", () => {
  const errors = errorsOf("version: 1\nrules:\n  - base: main\n    strategy: fast-forward\n");
  expect(errors.join(" ")).toContain("rules[0].strategy");
});

test("an empty branch pattern is rejected", () => {
  const errors = errorsOf('version: 1\nrules:\n  - base: ""\n    strategy: squash\n');
  expect(errors.join(" ")).toContain("rules[0].base");
});

test("forbid is only a rule strategy, never a default", () => {
  expect(errorsOf("version: 1\ndefaults:\n  strategy: forbid\n").join(" ")).toContain(
    "defaults.strategy",
  );
});

test("broken YAML is reported, not thrown", () => {
  expect(errorsOf("version: 1\nrules: [\n").join(" ")).toContain("not valid YAML");
});

test("a file that is not a mapping is reported", () => {
  expect(errorsOf("- version: 1\n").join(" ")).toContain("version");
});
