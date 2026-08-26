import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

/**
 * The layering in CLAUDE.md is a promise about portability: adding a runtime
 * must only touch `adapters/`.
 *
 * Imports of `adapters` and of `node:` builtins are denied by
 * `no-restricted-imports` in `vite.config.ts`, so every `vp check` covers those.
 * What is left here is what an import rule cannot see.
 */

const core = fileURLToPath(new URL("../src/core", import.meta.url));

async function coreSources(): Promise<{ name: string; source: string }[]> {
  const names = await readdir(core, { recursive: true });
  return Promise.all(
    names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map(async (name) => ({ name, source: await readFile(join(core, name), "utf8") })),
  );
}

async function offenders(pattern: RegExp): Promise<string[]> {
  return (await coreSources()).filter(({ source }) => pattern.test(source)).map(({ name }) => name);
}

describe("core stays runtime-agnostic", () => {
  test("no core module reads the environment directly", async () => {
    // Everything comes through the `Env` port instead.
    expect(await offenders(/process\.env/)).toEqual([]);
  });

  test("no core module mentions a Cloudflare type", async () => {
    expect(await offenders(/\b(ExecutionContext|KVNamespace|DurableObject)\b/)).toEqual([]);
  });
});
