import { expect, test } from "vite-plus/test";
import { ConfigurationError, readEnv, readPrivateKey } from "./env.ts";

const PKCS8 = "-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAKj3\n-----END PRIVATE KEY-----";

function source(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_APP_ID: "1234",
    GITHUB_APP_PRIVATE_KEY: PKCS8,
    GITHUB_WEBHOOK_SECRET: "secret",
    ...overrides,
  };
}

test("a complete environment is accepted", () => {
  expect(readEnv(source())).toEqual({
    appId: "1234",
    privateKey: PKCS8,
    webhookSecret: "secret",
    logLevel: "info",
    configCacheTtl: 60,
  });
});

test("a missing secret is named", () => {
  expect(() => readEnv(source({ GITHUB_WEBHOOK_SECRET: undefined }))).toThrow(
    /GITHUB_WEBHOOK_SECRET/,
  );
});

test("escaped line breaks are un-escaped", () => {
  // How a PEM usually survives a .env file or a copied-and-pasted secret.
  expect(readPrivateKey(PKCS8.replaceAll("\n", "\\n"))).toBe(PKCS8);
});

test("CRLF line endings are normalised", () => {
  expect(readPrivateKey(PKCS8.replaceAll("\n", "\r\n"))).toBe(PKCS8);
});

test("surrounding whitespace does not break the key", () => {
  expect(readPrivateKey(`\n  ${PKCS8}\n\n`)).toBe(PKCS8);
});

test("a PKCS#1 key says how to convert it", () => {
  const pkcs1 = PKCS8.replaceAll("PRIVATE KEY", "RSA PRIVATE KEY");
  expect(() => readPrivateKey(pkcs1)).toThrow(ConfigurationError);
  expect(() => readPrivateKey(pkcs1)).toThrow(/openssl pkcs8 -topk8/);
});

test("an OpenSSH key is refused", () => {
  expect(() =>
    readPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----"),
  ).toThrow(/OpenSSH/);
});

test("something that is not a PEM at all is refused", () => {
  expect(() => readPrivateKey("MIIBOgIBAAJBAKj3")).toThrow(/PKCS#8 PEM/);
});

test("the app id must be the numeric id, not the slug", () => {
  expect(() => readEnv(source({ GITHUB_APP_ID: "mergegate" }))).toThrow(/numeric app id/);
});

test("the log level falls back rather than failing", () => {
  expect(readEnv(source({ LOG_LEVEL: "chatty" })).logLevel).toBe("info");
  expect(readEnv(source({ LOG_LEVEL: "debug" })).logLevel).toBe("debug");
});

test("a nonsensical cache TTL falls back", () => {
  expect(readEnv(source({ CONFIG_CACHE_TTL: "-1" })).configCacheTtl).toBe(60);
  expect(readEnv(source({ CONFIG_CACHE_TTL: "abc" })).configCacheTtl).toBe(60);
  expect(readEnv(source({ CONFIG_CACHE_TTL: "5" })).configCacheTtl).toBe(5);
});
