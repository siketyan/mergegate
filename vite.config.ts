import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // Dependencies point adapters -> core, never the other way round, and
        // core sticks to web standard APIs. Core is everything under `src/`
        // that is not an adapter, so the rule is set for all of `src/` and
        // taken off `src/adapters/` below. See CLAUDE.md.
        files: ["src/**/*.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["**/adapters/**", "node:*", "node:*/**"],
                  message: "core must not depend on an adapter or on a node builtin",
                },
              ],
            },
          ],
        },
      },
      {
        // An adapter is the one place a runtime may be named.
        files: ["src/adapters/**/*.ts"],
        rules: {
          "no-restricted-imports": "off",
        },
      },
      {
        // Tests run in Node and read the source tree, so they are exempt.
        files: ["src/**/*.test.ts"],
        rules: {
          "no-restricted-imports": "off",
        },
      },
    ],
  },
  fmt: {
    // Generators own these; leaving them alone keeps `vp run codegen` and
    // `vp run schema` output byte-identical to what is committed.
    ignorePatterns: ["src/adapters/github/generated/**", "schema/**", "CHANGELOG.md"],
  },
});
