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
    check: { name: "squashables" },
    merge: {
      label: "ready-to-merge",
      manual: ["squash"],
      requireApproval: true,
      requireChecks: true,
      requireUpToDate: false,
      allowForkHead: false,
      deleteBranchOnMerge: false,
      removeLabelOnFailure: true,
      commitTitle: "Merge {head} into {base} (#{number})",
      commitMessage: "",
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
    expect(result.config.rules[0]).toEqual({ base: "staging", head: "**", strategy: "merge" });
  }
});

test("a missing version is rejected", () => {
  expect(errorsOf("rules: []\n").join(" ")).toContain("version");
});

test("a future version is rejected", () => {
  expect(errorsOf("version: 2\n").join(" ")).toContain("version");
});

test("unknown keys are rejected rather than ignored", () => {
  expect(errorsOf("version: 1\nstrategy: squash\n").join(" ")).toMatch(/unrecognized|unknown/i);
  expect(
    errorsOf("version: 1\nrules:\n  - base: main\n    strategy: squash\n    squash: true\n").join(
      " ",
    ),
  ).toMatch(/unrecognized|unknown/i);
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
  expect(errorsOf("- version: 1\n")).toEqual(["the configuration must be a mapping"]);
});
