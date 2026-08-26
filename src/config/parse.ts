import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import { type Config, configSchema } from "./schema.ts";

/** `rules[0].base`, the way the file itself reads. */
function formatPath(issue: v.BaseIssue<unknown>): string {
  const path = (issue.path ?? [])
    .map((item) => (typeof item.key === "number" ? `[${item.key}]` : `.${String(item.key)}`))
    .join("");
  return path.replace(/^\./, "") || "(root)";
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Parse `.github/mergegate.yml`. Never throws: an unparseable configuration is
 * a decision the app cannot make, and the caller fails the check run with these
 * messages.
 */
export function parseConfig(source: string): ConfigResult {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`the file is not valid YAML: ${message}`] };
  }

  const result = v.safeParse(configSchema, document);
  if (!result.success) {
    return {
      ok: false,
      errors: result.issues.map((issue) => `${formatPath(issue)}: ${issue.message}`),
    };
  }

  return { ok: true, config: result.output };
}

/** The configuration a repository without a configuration file behaves as. */
export function defaultConfig(): Config {
  return v.parse(configSchema, { version: 1 });
}
