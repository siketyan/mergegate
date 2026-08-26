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
        // core sticks to web standard APIs. See CLAUDE.md.
        files: ["src/core/**/*.ts"],
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
        // Tests run in Node and read the source tree, so they are exempt.
        files: ["src/**/*.test.ts"],
        rules: {
          "no-restricted-imports": "off",
        },
      },
    ],
  },
  fmt: {},
});
