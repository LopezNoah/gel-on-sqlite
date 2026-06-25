import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openSQLite } from "../src/runtime/database.js";
import { executeQuery } from "../src/runtime/engine.js";
import { deserializeSchemaFromInstdata } from "../src/schema/gel_persistence.js";
import { Client } from "../src/client/index.js";
import { push } from "../src/migrate/migrator.js";
import { generateQueryClient } from "../src/codegen/queries.js";

const SCHEMA = `module default {
  type Person {
    required name: str;
    age: int64;
    email: str;
  }
}`;

const setup = (queries: Record<string, string>): { dir: string; out: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gel-cg-"));
  const qdir = path.join(dir, "queries");
  fs.mkdirSync(qdir);
  for (const [file, body] of Object.entries(queries)) fs.writeFileSync(path.join(qdir, file), body);
  return { dir: qdir, out: path.join(dir, "out.ts") };
};

describe("generateQueryClient", () => {
  it("types an object-shape select as a Promise of an array of the projected fields", () => {
    const { dir, out } = setup({ "allPeople.edgeql": "select default::Person { name, age };" });
    const res = generateQueryClient({ schemaSource: SCHEMA, queriesDir: dir, outFile: out });
    expect(res.generated).toBe(1);
    const code = fs.readFileSync(out, "utf-8");
    expect(code).toContain("export type AllPeopleResult = {");
    expect(code).toContain("name: string;");
    expect(code).toContain("age?: number;");
    expect(code).toContain("export function allPeople(client: Executor): Promise<AllPeopleResult[]>");
    expect(code).toContain("return client.query<AllPeopleResult>(");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("types parameters and forwards them to the Client", () => {
    const { dir, out } = setup({
      "personByName.edgeql": "select default::Person { name } filter .name = <str>$name;",
    });
    generateQueryClient({ schemaSource: SCHEMA, queriesDir: dir, outFile: out });
    const code = fs.readFileSync(out, "utf-8");
    expect(code).toContain("export type PersonByNameParams = {");
    expect(code).toContain("name: string;");
    expect(code).toContain("export function personByName(client: Executor, params: PersonByNameParams)");
    expect(code).toContain("PersonByName_QUERY, params)");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("types a scalar aggregate as queryRequiredSingle → Promise<number>", () => {
    const { dir, out } = setup({ "personCount.edgeql": "select count(default::Person);" });
    generateQueryClient({ schemaSource: SCHEMA, queriesDir: dir, outFile: out });
    const code = fs.readFileSync(out, "utf-8");
    expect(code).toContain("export type PersonCountResult = number;");
    expect(code).toContain("export function personCount(client: Executor): Promise<PersonCountResult>");
    expect(code).toContain("return client.queryRequiredSingle<PersonCountResult>(");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("warns and skips a query that does not compile", () => {
    const { dir, out } = setup({ "bad.edgeql": "select default::Nope { nope };" });
    const res = generateQueryClient({ schemaSource: SCHEMA, queriesDir: dir, outFile: out });
    expect(res.generated).toBe(0);
    expect(res.warnings.join("\n")).toContain("bad.edgeql");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  // The real proof: generate, import the module, and run a parameterized query
  // through an actual Client — exercising Client.query(query, args) end to end.
  it("produces a function that runs against a real Client with params", async () => {
    const { db } = openSQLite(":memory:");
    push(db, SCHEMA);
    const schema = deserializeSchemaFromInstdata(db);
    if (!schema) throw new Error("no schema");
    executeQuery(db, schema, "insert default::Person { name := 'Alice', age := 30 };");
    executeQuery(db, schema, "insert default::Person { name := 'Bob', age := 25 };");

    const { dir, out } = setup({
      "peopleByName.edgeql": "select default::Person { name, age } filter .name = <str>$name;",
    });
    generateQueryClient({ schemaSource: SCHEMA, queriesDir: dir, outFile: out });

    const mod = (await import(pathToFileURL(out).href)) as {
      peopleByName: (c: Client, p: { name: string }) => Promise<Array<{ name: string; age?: number }>>;
    };
    const client = Client.fromParts(db, schema);
    const rows = await mod.peopleByName(client, { name: "Alice" });

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Alice");
    expect(rows[0].age).toBe(30);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});
