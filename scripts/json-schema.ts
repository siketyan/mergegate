import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toJsonSchema } from "@valibot/to-json-schema";
import { configSchema } from "../src/core/config/schema.ts";

/**
 * The JSON Schema is generated from the valibot schema rather than written by
 * hand, so an editor can never disagree with what the app accepts. Run
 * `vp run schema` after changing the configuration schema.
 *
 * Two things valibot expresses that JSON Schema cannot: the transform that
 * normalises `head` into a list, and the check that `includeTransitive` has a
 * literal branch to follow. `errorMode: "ignore"` keeps them out of the output
 * instead of failing the conversion — an editor will accept a shape the app
 * then rejects with a message of its own, which is the right way round.
 */
const generated = toJsonSchema(configSchema, { errorMode: "ignore" });

const schema = {
  // The converter emits draft-07 constructs and says so itself; this only
  // fixes where the key lands in the file.
  $schema: generated.$schema,
  $id: "https://raw.githubusercontent.com/siketyan/mergegate/main/schema/mergegate.schema.json",
  title: "mergegate configuration",
  description: "Merge strategy rules for .github/mergegate.yml",
  ...generated,
};

const out = fileURLToPath(new URL("../schema/mergegate.schema.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../schema", import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`wrote ${out}`);
