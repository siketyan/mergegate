import { expect, test } from "vite-plus/test";
import { ContentDecodeError, decodeBase64, decodeContent } from "./content.ts";

const PATH = ".github/mergegate.yml";

test("the raw media type comes back as the file itself", () => {
  expect(decodeContent(PATH, "version: 1\n")).toBe("version: 1\n");
});

test("a base64 envelope is decoded, wrapped or not", () => {
  const yaml = "version: 1\nrules: []\n";
  const packed = btoa(yaml);
  const wrapped = `${packed.slice(0, 4)}\n${packed.slice(4)}\n`;

  for (const content of [packed, wrapped]) {
    expect(decodeContent(PATH, { type: "file", encoding: "base64", content })).toBe(yaml);
  }
});

test("UTF-8 survives the base64 envelope", () => {
  const yaml = "# 日本語のコメント\nversion: 1\n";
  const bytes = new TextEncoder().encode(yaml);
  const packed = btoa(String.fromCharCode(...bytes));
  expect(decodeContent(PATH, { type: "file", encoding: "base64", content: packed })).toBe(yaml);
});

test("a directory is not a configuration file", () => {
  expect(decodeContent(PATH, [{ type: "file", name: "mergegate.yml" }])).toBeNull();
  expect(decodeContent(PATH, { type: "dir" })).toBeNull();
});

test("a file too large to inline is an error, not a missing file", () => {
  // Reporting "no configuration" here would silently let every pull request
  // through as a squash.
  expect(() => decodeContent(PATH, { type: "file", encoding: "none", content: "" })).toThrow(
    ContentDecodeError,
  );
});

test("undecodable base64 names the file rather than blaming atob", () => {
  expect(() => decodeBase64(PATH, "not base64 !!")).toThrow(ContentDecodeError);
  expect(() => decodeBase64(PATH, "not base64 !!")).toThrow(/mergegate\.yml/);
});
