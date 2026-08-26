import { parse as parseYaml } from "yaml";
import { type Config, configSchema } from "./schema.ts";

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly errors: readonly string[] };

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "(root)";
  }
  return path.reduce<string>((accumulator, segment) => {
    if (typeof segment === "number") {
      return `${accumulator}[${segment}]`;
    }
    return accumulator === "" ? String(segment) : `${accumulator}.${String(segment)}`;
  }, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `.github/squashables.yml`. Never throws: an unparseable configuration is
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

  if (!isPlainObject(document)) {
    return { ok: false, errors: ["the configuration must be a mapping"] };
  }

  const result = configSchema.safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`),
    };
  }

  return { ok: true, config: result.data };
}

/** The configuration a repository without a configuration file behaves as. */
export function defaultConfig(): Config {
  return configSchema.parse({ version: 1 });
}
