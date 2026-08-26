import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

/**
 * The layering in CLAUDE.md is a promise about portability: adding a runtime
 * must only touch `adapters/`. These rules are cheap to state and easy to break
 * by accident, so they are checked rather than merely written down.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(path);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );
  return files.flat();
}

async function coreSources(): Promise<{ path: string; source: string }[]> {
  const files = await sourceFiles(join(root, "src", "core"));
  return Promise.all(files.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
}

describe("core stays runtime-agnostic", () => {
  test("no core module imports an adapter", async () => {
    const offenders = (await coreSources())
      .filter(({ source }) => /from\s+"[^"]*adapters\//.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  test("no core module imports a node builtin", async () => {
    const offenders = (await coreSources())
      .filter(({ source }) => /from\s+"node:/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  test("no core module reads the environment directly", async () => {
    const offenders = (await coreSources())
      .filter(({ source }) => source.includes("process.env"))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  test("no core module mentions a Cloudflare type", async () => {
    const offenders = (await coreSources())
      .filter(({ source }) => /\b(ExecutionContext|KVNamespace|DurableObject)\b/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
