import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * Types for the GraphQL query are generated from GitHub's published schema
 * rather than hand-written, so a field that changes shape is a type error here
 * instead of a surprise at runtime. Run `pnpm codegen` after editing a query.
 */
const config: CodegenConfig = {
  schema: "node_modules/@octokit/graphql-schema/schema.graphql",
  documents: ["src/adapters/github/**/*.ts"],
  generates: {
    "src/adapters/github/generated/graphql.ts": {
      plugins: ["typescript-operations"],
      config: {
        // Only what the queries in this repository actually reach for: the full
        // GitHub schema would be tens of thousands of lines.
        onlyOperationTypes: true,
        enumsAsTypes: true,
        useTypeImports: true,
        skipTypename: false,
        // GitHub's git scalars are strings on the wire.
        scalars: { GitObjectID: "string", GitRefname: "string", URI: "string" },
      },
    },
  },
};

export default config;
