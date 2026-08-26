import type { Env } from "../../core/ports.ts";

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment value: ${name}`);
  }
  return value;
}

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** Turns a flat string map into the `Env` port. No runtime globals are read. */
export function readEnv(source: Record<string, string | undefined>): Env {
  const logLevel = source.LOG_LEVEL ?? "info";
  const ttl = Number(source.CONFIG_CACHE_TTL ?? "60");

  return {
    appId: required(source, "GITHUB_APP_ID"),
    privateKey: required(source, "GITHUB_APP_PRIVATE_KEY"),
    webhookSecret: required(source, "GITHUB_WEBHOOK_SECRET"),
    logLevel: LEVELS.has(logLevel) ? (logLevel as Env["logLevel"]) : "info",
    configCacheTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 60,
  };
}
