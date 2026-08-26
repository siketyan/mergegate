import { expect, test } from "vite-plus/test";
import { decodeContent } from "./content.ts";

const PATH = ".github/mergegate.yml";

test("the raw media type comes back as the file itself", () => {
  expect(decodeContent(PATH, "version: 1\n")).toBe("version: 1\n");
});

test("anything but the file names the path rather than failing later", () => {
  // Reporting "no configuration" here would silently let every pull request
  // through as a squash.
  expect(() => decodeContent(PATH, { type: "file", encoding: "none" })).toThrow(
    /mergegate\.yml.*expected the raw file/,
  );
});
