import fs from "node:fs";
import path from "node:path";
import { parseDeclarativeSchema } from "./src/schema/sdl_adapter.js";
import { schemaSnapshotFromDeclarative } from "./src/schema/uiSchema.js";

const source = fs.readFileSync(path.join(process.cwd(), "tests/schemas/advtypes.esdl"), "utf8");
const decl = parseDeclarativeSchema(`module default {\n${source}\n}`, { legacySyntaxCompat: true });
const schema = schemaSnapshotFromDeclarative(decl);

console.log("=== DerivedCompSinglePropA ===");
const a = schema.getType("default::DerivedCompSinglePropA");
console.dir({
  name: a?.name,
  extends: a?.extends,
  fields: a?.fields,
  computeds: a?.computeds,
}, { depth: null });

console.log("\n=== BaseCompSingleProp ===");
const b = schema.getType("default::BaseCompSingleProp");
console.dir({
  name: b?.name,
  computeds: b?.computeds,
}, { depth: null });

console.log("\n=== SoloCompSinglePropA ===");
const c = schema.getType("default::SoloCompSinglePropA");
console.dir({
  name: c?.name,
  computeds: c?.computeds,
}, { depth: null });
