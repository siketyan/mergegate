import type { Env } from "../../core/ports.ts";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name];
  if (value === undefined || value === "") {
    throw new ConfigurationError(`missing required environment value: ${name}`);
  }
  return value;
}

const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
const PKCS8_FOOTER = "-----END PRIVATE KEY-----";

/**
 * Secret stores mangle PEM files in predictable ways, and the failure lands deep
 * inside the JWT signing code as an opaque decode error. Normalise what can be
 * normalised and name what cannot.
 */
export function readPrivateKey(raw: string): string {
  const key = raw.replaceAll("\\n", "\n").replaceAll("\r\n", "\n").trim();

  if (key.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new ConfigurationError(
      "GITHUB_APP_PRIVATE_KEY is a PKCS#1 key. WebCrypto only signs with PKCS#8; convert it with " +
        "`openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8.pem`",
    );
  }
  if (key.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new ConfigurationError(
      "GITHUB_APP_PRIVATE_KEY is an OpenSSH key. Use the PKCS#8 PEM GitHub issued for the app.",
    );
  }
  if (!key.startsWith(PKCS8_HEADER) || !key.endsWith(PKCS8_FOOTER)) {
    throw new ConfigurationError(
      `GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM, starting with ${PKCS8_HEADER} and ending ` +
        `with ${PKCS8_FOOTER}`,
    );
  }
  return key;
}

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** Turns a flat string map into the `Env` port. No runtime globals are read. */
export function readEnv(source: Record<string, string | undefined>): Env {
  const logLevel = source.LOG_LEVEL ?? "info";
  const ttl = Number(source.CONFIG_CACHE_TTL ?? "60");
  const appId = required(source, "GITHUB_APP_ID");

  if (!/^\d+$/.test(appId)) {
    throw new ConfigurationError(
      "GITHUB_APP_ID must be the numeric app id from the app's settings page, not its slug",
    );
  }

  return {
    appId,
    privateKey: readPrivateKey(required(source, "GITHUB_APP_PRIVATE_KEY")),
    webhookSecret: required(source, "GITHUB_WEBHOOK_SECRET"),
    logLevel: LEVELS.has(logLevel) ? (logLevel as Env["logLevel"]) : "info",
    configCacheTtl: Number.isFinite(ttl) && ttl > 0 ? ttl : 60,
  };
}
