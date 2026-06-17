# `parseDDL` carries the `CREATE TYPE` body on the AST (Stage D1b)

After D1a relocated `parseCreateTypeBody` into the edgeql layer, the parser can own the DDL body. This step has `edgeql/parser.ts::parseDDL` parse the `CREATE TYPE { … }` body into structured entries on the AST, so the runtime can later read the parsed body off the AST instead of re-parsing the source (Stage D1c).

**Decision (done):**
- `DDLStatement` (`edgeql/ast.ts`) gains `createTypeBody?: CreateTypeBodyEntry[]` (a type-only import from `edgeql/ddl_body.ts` — no runtime cycle).
- `parseDDL` adds a branch: for `action === "create" && objectKind === "type"`, it calls a new `captureCreateTypeBody()` instead of the bare `skipDDLBody()`. `captureCreateTypeBody` matches the body's leading `{` to its `}` over the already-tokenized stream, slices the inner text via the existing `sliceSource`, advances the cursor with the same `skipDDLBody()` as before, and returns `parseCreateTypeBody(bodyText)` — the same parser the runtime consumes (ADR 0026). A body-less `CREATE TYPE Foo;` returns `undefined`.

**Why this is safe (additive).** Nothing reads `createTypeBody` yet — the runtime still registers types via its string pre-pass (Stage D1c switches it over). Token consumption is unchanged: `captureCreateTypeBody` does a read-only span scan, then calls the *same* `skipDDLBody()` the CREATE-TYPE branch always called, so the cursor ends in the same place. `parseCreateTypeBody` is defensive (never throws — unrecognised entries are skipped), so it cannot break a parse. Only `CREATE TYPE` statements do the extra work, and DDL is not a hot query path.

**Verification.** `npx tsc` 0 errors. Behaviour-neutral: the gate slice (`edgeql_userddl` / `edgeql_insert` / `edgeql_syntax`) ran `54–55 failed / 1016–1017 passed` — the ±1 is the `insert` suite's documented order-flakiness (the *same* post-D1b code produced both 54 and 55 across runs), not a regression. `tests/ddl_ast_body.test.ts` (4 new tests) locks the capability: the AST carries the structured members, a type-level exclusive constraint, `undefined` for a body-less type, and (deliberately) no body for `ALTER TYPE` yet.

**Decision (deferred to D1b2 / D1c):** `ALTER TYPE` bodies are still skipped by the parser (its ops live only in the runtime's `parseAlterTypeStatement`); a structured `alterTypeOps` on the AST is the next step, after which the runtime pre-pass can be made fully AST-driven and the string shadow parser deleted.

**Why record it:** a future reader will see `parseDDL` populate `createTypeBody` that nothing consumes yet. That is the intended additive intermediate state — the parser now owns the parsed `CREATE TYPE` body; Stage D1c repoints the runtime onto it and removes the duplicate string parse.
