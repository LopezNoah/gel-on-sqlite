import { quoteIdent, quoteLiteral } from "../codegen/sql.js";
import type {
  CallArg,
  FunctionCall,
  GroupElementsField,
  GroupRowsExpr,
  GroupRowFieldExpr,
  GroupRowProjection,
  GroupStmt,
  OperatorCall,
  SelectExpr,
  Set,
  SortExpr,
  Tuple,
} from "../ir/gel_ir.js";
import type { RuntimeTarget } from "../runtime/target.js";
import type { ScalarValue } from "../types.js";
import { ShapeLoweringMiss, type GelIRCompileOptions, type GelIRSQLArtifact } from "./compiler_types.js";
import type { SqlLoweringContext } from "./function_lowering.js";

// Lower a top-level `GROUP <subject> BY <fields>` to a single SQL statement
// producing one row per group, each row's `value` column holding the group
// object `{ key: {...}, grouping: [...], elements: [...] }`. The subject
// compiles to a value-per-row subquery (`SELECT <json element> AS "value"
// FROM …`); we read the key fields out of that JSON with `json_extract` and
// re-aggregate the elements with `json_group_array` — one GROUP BY branch
// per expanded grouping set, UNION ALL'd. `key` carries every BY atom (NULL
// when the branch's set doesn't include it) and `grouping` lists the
// branch's atoms, matching the runtime grouper's row contract. Statements
// the IR builder marked non-lowerable (no `byAtoms`) return an empty
// fallback artifact so the engine routes them to the runtime grouper.
export const compileGroupStmtToSQL = (
  statement: GroupStmt,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): GelIRSQLArtifact => {
  const target = options.target ?? "sqlite";
  const params: ScalarValue[] = [];
  const sql = compileGroupRowsSQL(statement, params, target, options, deps);
  if (!sql) {
    return { sql: "", params, loweringMode: "fallback_multi_query" };
  }
  return { sql, params, loweringMode: "single_statement" };
};

// One-row-per-group SQL for a GroupStmt — shared by the top-level statement
// artifact above and expression-position `group_rows` sets (see
// compileGroupRowsStatementSQL). Returns null when the statement is
// non-lowerable (no byAtoms) or the subject doesn't lower.
export const compileGroupRowsSQL = (
  statement: GroupStmt,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const byAtoms = statement.byAtoms;
  const groupingSets = statement.groupingSets ?? (byAtoms ? [byAtoms] : undefined);
  if (!byAtoms || byAtoms.length === 0 || !groupingSets || groupingSets.length === 0) {
    return null;
  }

  // The subject yields one `value`-column row per element (json_object). Its
  // FOR/shape lowering correlates iterator vars correctly (see
  // compileShapeObjectWithAliases). strictShape: a subject field that doesn't
  // lower must bail to the runtime grouper — a lossy projection would emit
  // group elements with silently-missing fields. Compiled once per branch so
  // the positional params repeat with the duplicated SQL text.
  const compileSubject = (): string | null => {
    // A free-object subject with a multi field (`{a := 1, b := {2, 3, 4}}`)
    // is still ONE element row — aggregate union-valued fields into JSON
    // arrays instead of letting the generic tuple lowering cross-join them.
    {
      let tupleCursor: Set = statement.subject;
      while (tupleCursor.expr.kind === "select_expr") {
        tupleCursor = (tupleCursor.expr as SelectExpr).result;
      }
      // A multi field aggregates into a JSON array: a `union` (`b := {2,3,4}`)
      // or a FOR over a plain value (`b := (for n in {8,9} select n)`) — both
      // produce many rows for the one free-object element. A FOR whose body is
      // an OBJECT (`union ({c, d})`) is NOT aggregated here: it lowers through
      // the generic shaped-subject path, so leave the trigger off for it.
      const isMultiField = (s: Set): boolean => {
        if (s.expr.kind === "operator_call" && (s.expr as OperatorCall).operator === "union") return true;
        if (s.expr.kind === "for_expr") {
          let body = (s.expr as { body: Set }).body;
          while (body.expr.kind === "select_expr") body = (body.expr as SelectExpr).result;
          return body.expr.kind !== "tuple" && (body.shape?.length ?? 0) === 0;
        }
        return false;
      };
      if (tupleCursor.expr.kind === "tuple" && (tupleCursor.expr as Tuple).named
          && (tupleCursor.expr as Tuple).elements.some((el) => isMultiField(el.val))) {
        const cp = params.length;
        const pairs: string[] = [];
        let ok = true;
        for (const element of (tupleCursor.expr as Tuple).elements) {
          if (!element.name) { ok = false; break; }
          const rows = deps.compileScalarSelectSQL(element.val, params, target, options, []);
          if (!rows) { ok = false; break; }
          const isMulti = isMultiField(element.val);
          const inner = deps.setValueIsJson(element.val) ? `json(${quoteIdent("value")})` : quoteIdent("value");
          const valueSql = isMulti
            ? `json((SELECT COALESCE(json_group_array(${inner}), '[]') FROM (${rows})))`
            : deps.setValueIsJson(element.val)
              ? `json((SELECT ${quoteIdent("value")} FROM (${rows}) LIMIT 1))`
              : `(SELECT ${quoteIdent("value")} FROM (${rows}) LIMIT 1)`;
          pairs.push(`${quoteLiteral(element.name)}, ${valueSql}`);
        }
        if (ok) {
          return `SELECT json_object(${pairs.join(", ")}) AS ${quoteIdent("value")}`;
        }
        params.length = cp;
        return null;
      }
    }
    try {
      return deps.compileScalarSelectSQL(statement.subject, params, target, { ...options, strictShape: true }, []);
    } catch (err) {
      if (!(err instanceof ShapeLoweringMiss)) throw err;
      if (process.env.DBG_GROUP_SQL) console.error("[group-sql] subject miss:", err.message);
      return null;
    }
  };

  const subjectAlias = "grp_src";
  const valueCol = `${subjectAlias}.${quoteIdent("value")}`;
  // SQLite JSON path for a (quoted) object field — `$."name"`.
  const fieldPath = (name: string): string => `'$."${name.replaceAll('"', '""')}"'`;
  // A self-key alias (`group X using z := X by z`) groups on the WHOLE element
  // value, not a sub-field — its key/group-by read `value` directly.
  const selfKeys = new globalThis.Set<string>(statement.selfKeyAliases ?? []);
  const keyExtract = (name: string): string =>
    selfKeys.has(name) ? valueCol : `json_extract(${valueCol}, ${fieldPath(name)})`;

  // Strip the key-only (hidden) BY fields from the displayed elements so the
  // output shape stays as written. `json()` re-asserts the JSON subtype so
  // json_group_array embeds the object rather than quoting it as text.
  // Scalar-element subjects instead re-read the raw element value the
  // desugared FOR carried along (json_extract keeps the subtype for nested
  // arrays/objects and passes scalars through). A self-key subject's element
  // IS the whole value.
  const hidden = statement.hiddenByFields ?? [];
  const elementExpr = selfKeys.size > 0
    ? `json(${valueCol})`
    : statement.elementValueField
      ? `json_extract(${valueCol}, ${fieldPath(statement.elementValueField)})`
      : hidden.length > 0
        ? `json(json_remove(${valueCol}, ${hidden.map((n) => fieldPath(n)).join(", ")}))`
        : `json(${valueCol})`;

  const distinctAtoms = [...new Set<string>(byAtoms)];
  const branches: string[] = [];
  for (const set of groupingSets) {
    const subjectSql = compileSubject();
    if (!subjectSql) {
      return null;
    }
    const inSet = new globalThis.Set<string>(set);
    // `->` (not json_extract) so JSON booleans survive into the key object —
    // json_extract flattens `true` to integer 1.
    const keyPairs = distinctAtoms.map((name) =>
      `${quoteLiteral(name)}, ${inSet.has(name) ? (selfKeys.has(name) ? `json(${valueCol})` : `${valueCol} -> ${fieldPath(name)}`) : "NULL"}`);
    const groupingArr = `json_array(${set.map((n) => quoteLiteral(n)).join(", ")})`;
    const groupObj = `json_object(`
      + `${quoteLiteral("key")}, json_object(${keyPairs.join(", ")}), `
      + `${quoteLiteral("grouping")}, ${groupingArr}, `
      + `${quoteLiteral("elements")}, COALESCE(json_group_array(${elementExpr}), json('[]'))`
      + `)`;
    const groupByCols = [...new Set<string>(set.map(keyExtract))];
    let branch = `SELECT ${groupObj} AS ${quoteIdent("value")}`
      + ` FROM (${subjectSql}) ${subjectAlias}`;
    // A zero-atom grouping set (the CUBE/ROLLUP base set) aggregates the
    // whole subject into one group — but must emit no group at all when the
    // subject is empty, where a bare aggregate would still return one row.
    branch += groupByCols.length > 0
      ? ` GROUP BY ${groupByCols.join(", ")}`
      : ` HAVING COUNT(*) > 0`;
    branches.push(branch);
  }

  return branches.join(" UNION ALL ");
};

export const groupProjectionHead = (
  ctx: NonNullable<GelIRCompileOptions["groupRowProjection"]>,
  steps: string[],
): GroupRowProjection | undefined => ctx.projections.get(steps[0] ?? "");

// `SELECT (GROUP …) [{…}] [FILTER … ORDER BY …]` — group rows in statement
// position (including via WITH bindings). Lowers the group, applies the
// projection (each pair re-reads the row's JSON `value`), then compiles the
// statement clauses against the rows: group_row_field paths resolve through
// options.groupRowProjection so projected names re-emit their projection
// expression and unprojected names read the raw row path.
// The projected group-rows SQL (`SELECT <projection json> AS "value" FROM
// (<group rows>) grw`) without statement clauses — shared by the statement
// compiler below and by group-rows-as-subject lowering (an outer GROUP over
// the projected rows of an inner one). Returns null when non-lowerable.
export const compileGroupRowsValueSQL = (
  groupRows: GroupRowsExpr,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  alias: string,
  deps: SqlLoweringContext,
): string | null => {
  if (groupRows.unlowerable) {
    if (process.env.DBG_GROUP_SQL) console.error("[group-sql] group rows unlowerable flag");
    return null;
  }
  const rowsSql = compileGroupRowsSQL(groupRows.group, params, target, options, deps);
  if (!rowsSql) {
    if (process.env.DBG_GROUP_SQL) console.error("[group-sql] group rows SQL null; byAtoms:", JSON.stringify(groupRows.group.byAtoms));
    return null;
  }
  const rawValue = `${alias}.${quoteIdent("value")}`;
  const jsonPath = (steps: string[]): string =>
    `'$${steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("")}'`;

  const projectionExprSQL = (proj: GroupRowProjection): string => {
    if (proj.kind === "path") {
      const extract = `json_extract(${rawValue}, ${jsonPath(proj.steps)})`;
      // Container roots keep their JSON subtype; deeper paths are scalar
      // leaves read as plain values.
      const container = proj.steps.length === 1
        && (proj.steps[0] === "key" || proj.steps[0] === "grouping" || proj.steps[0] === "elements");
      return container ? `json(${extract})` : extract;
    }
    if (proj.kind === "count_elements") {
      return `json_array_length(COALESCE(json_extract(${rawValue}, '$."elements"'), '[]'))`;
    }
    if (proj.kind === "key_shape") {
      const pairs = proj.fields.map((field) =>
        `${quoteLiteral(field)}, json_extract(${rawValue}, ${jsonPath(["key", field])})`);
      return `json_object(${pairs.join(", ")})`;
    }
    if (proj.kind === "element_first_path") {
      const tail = proj.steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("");
      return `json_extract(${rawValue}, '$."elements"[0]${tail}')`;
    }
    if (proj.kind === "element_first_shape") {
      const pairs = proj.fields.map((field) =>
        `${quoteLiteral(field)}, json_extract(${rawValue}, '$."elements"[0]."${field.replaceAll('"', '""')}"')`);
      return `json_object(${pairs.join(", ")})`;
    }
    if (proj.kind === "element_agg") {
      const tail = proj.steps.map((s) => `."${s.replaceAll('"', '""')}"`).join("");
      return `(SELECT ${proj.fn === "avg" ? "avg" : proj.fn}(json_extract(je.${quoteIdent("value")}, '$${tail}'))`
        + ` FROM json_each(COALESCE(json_extract(${rawValue}, '$."elements"'), '[]')) je)`;
    }
    if (proj.kind === "sorted_grouping") {
      return `json((SELECT json_group_array(je.${quoteIdent("value")})`
        + ` FROM (SELECT ${quoteIdent("value")} FROM json_each(COALESCE(json_extract(${rawValue}, '$."grouping"'), '[]')) ORDER BY ${quoteIdent("value")}) je))`;
    }
    // elements_shape: re-project each element object — plain fields pass
    // through, compare computeds emit a JSON boolean, nested object
    // sub-shapes recurse with their path prefix.
    const elementFieldPair = (field: GroupElementsField, basePath: string[]): string => {
      if (field.kind === "field") {
        return `${quoteLiteral(field.name)}, json_extract(je.${quoteIdent("value")}, ${jsonPath([...basePath, field.name])})`;
      }
      if (field.kind === "object_shape") {
        const subPairs = field.fields.map((sub) => elementFieldPair(sub, [...basePath, field.name]));
        return `${quoteLiteral(field.name)}, json_object(${subPairs.join(", ")})`;
      }
      if (field.kind === "count_path") {
        return `${quoteLiteral(field.name)}, json_array_length(COALESCE(json_extract(je.${quoteIdent("value")}, ${jsonPath([...basePath, ...field.steps])}), '[]'))`;
      }
      params.push(field.rhs as ScalarValue);
      const lhs = `json_extract(je.${quoteIdent("value")}, ${jsonPath([...basePath, ...field.steps])})`;
      return `${quoteLiteral(field.name)}, (CASE WHEN ${lhs} ${field.op} ? THEN json('true') ELSE json('false') END)`;
    };
    const shapeFields = (proj as Extract<GroupRowProjection, { kind: "elements_shape" }>).fields;
    const pairs = shapeFields.map((field) => elementFieldPair(field, []));
    return `json(COALESCE((SELECT json_group_array(json_object(${pairs.join(", ")}))`
      + ` FROM json_each(COALESCE(json_extract(${rawValue}, '$."elements"'), '[]')) je), '[]'))`;
  };

  // Anything outside the static projection model compiles as an IR value
  // per group row, with this row bound as the active group-row scope. A
  // multi value (FOR over an inner group, an elements chain) aggregates
  // into a JSON array.
  const computedSetSQL = (proj: Extract<GroupRowProjection, { kind: "computed_set" }>): string | null => {
    const projections = new Map<string, GroupRowProjection>();
    for (const p of groupRows.projection ?? []) projections.set(p.name, p);
    const rowOptions: GelIRCompileOptions = { ...options, groupRowProjection: { alias, projections } };
    let cursor: Set = proj.value;
    while (cursor.expr.kind === "select_expr") {
      const wrapper = cursor.expr as SelectExpr;
      if (wrapper.where || wrapper.limit || wrapper.offset || (wrapper.orderBy && wrapper.orderBy.length > 0)) break;
      cursor = wrapper.result;
    }
    const multi = cursor.expr.kind === "for_expr" || cursor.expr.kind === "group_rows"
      || (cursor.expr.kind === "group_row_field" && (cursor.expr as GroupRowFieldExpr).steps[0] === "elements")
      || (cursor.expr.kind === "operator_call" && (cursor.expr as OperatorCall).operator === "union");
    const cp = params.length;
    if (!multi) {
      const v = deps.compileValueSetSQL(proj.value, alias, params, target, rowOptions);
      if (v) return v;
      params.length = cp;
    }
    const rows = deps.compileScalarSelectSQL(proj.value, params, target, rowOptions, []);
    if (rows) {
      const inner = deps.setValueIsJson(proj.value) ? `json(${quoteIdent("value")})` : quoteIdent("value");
      return `json(COALESCE((SELECT json_group_array(${inner}) FROM (${rows}) WHERE ${quoteIdent("value")} IS NOT NULL), '[]'))`;
    }
    if (process.env.DBG_GROUP_SQL) console.error("[group-sql] computed_set miss:", proj.name, cursor.expr.kind);
    params.length = cp;
    return null;
  };

  let valueSQL = `json(${rawValue})`;
  if (groupRows.projection && groupRows.projection.length > 0) {
    const pairs: string[] = [];
    for (const proj of groupRows.projection) {
      const exprSql = proj.kind === "computed_set" ? computedSetSQL(proj) : projectionExprSQL(proj);
      if (!exprSql) return null;
      pairs.push(`${quoteLiteral(proj.name)}, ${exprSql}`);
    }
    valueSQL = `json_object(${pairs.join(", ")})`;
  }

  return `SELECT ${valueSQL} AS ${quoteIdent("value")} FROM (${rowsSql}) ${alias}`;
};

export const compileGroupRowsStatementSQL = (
  groupRows: GroupRowsExpr,
  where: Set | undefined,
  orderBy: SortExpr[] | undefined,
  limit: Set | undefined,
  offset: Set | undefined,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): GelIRSQLArtifact => {
  const fallback: GelIRSQLArtifact = { sql: "", params, loweringMode: "fallback_multi_query" };
  const alias = "grw";
  const projectedSql = compileGroupRowsValueSQL(groupRows, params, target, options, alias, deps);
  if (!projectedSql) return fallback;

  // Clause refs resolve against the RAW row alias: projected names re-emit
  // their projection expression (options.groupRowProjection), anything else
  // reads the raw row's JSON path. projectedSql is a single bare SELECT, so
  // WHERE/ORDER BY append directly.
  const projections = new Map<string, GroupRowProjection>();
  for (const proj of groupRows.projection ?? []) projections.set(proj.name, proj);
  const clauseOptions: GelIRCompileOptions = { ...options, groupRowProjection: { alias, projections } };

  let sql = projectedSql;
  if (where) {
    const whereSql = deps.compilePredicateSetSQL(where, alias, params, target, clauseOptions)
      ?? deps.compileValueSetSQL(where, alias, params, target, clauseOptions);
    if (!whereSql) return fallback;
    sql += ` WHERE ${whereSql}`;
  }
  if (orderBy && orderBy.length > 0) {
    const parts: string[] = [];
    for (const sort of orderBy) {
      // A tuple sort key (`ORDER BY (count(.grouping), array_agg(…))`)
      // expands into one ORDER BY term per element.
      const sortKeys: Set[] = [];
      const peeled = deps.unwrapSelectExprSet(sort.path).result;
      if (peeled.expr.kind === "tuple") {
        for (const el of (peeled.expr as Tuple).elements) sortKeys.push(el.val);
      } else {
        sortKeys.push(sort.path);
      }
      for (const key of sortKeys) {
        const sortSql = compileGroupRowSortSQL(key, alias, params, target, clauseOptions, deps);
        if (!sortSql) return fallback;
        parts.push(`${sortSql} ${sort.direction === "desc" ? "DESC" : "ASC"}`);
      }
    }
    sql += ` ORDER BY ${parts.join(", ")}`;
  }
  const limitValue = limit ? deps.extractNumericLiteral(limit) : undefined;
  const offsetValue = offset ? deps.extractNumericLiteral(offset) : undefined;
  if (limit && limitValue === undefined) return fallback;
  if (offset && offsetValue === undefined) return fallback;
  if (limitValue !== undefined) sql += ` LIMIT ${limitValue}`;
  if (offsetValue !== undefined) {
    if (limitValue === undefined) sql += ` LIMIT -1`;
    sql += ` OFFSET ${offsetValue}`;
  }
  return { sql, params, loweringMode: "single_statement" };
};

// ORDER BY over group rows: the standard value compile, plus the
// sorted-grouping idiom `array_agg((SELECT _ := .grouping ORDER BY _))` —
// emitted as the grouping names re-aggregated in sorted order.
const compileGroupRowSortSQL = (
  path: Set,
  alias: string,
  params: ScalarValue[],
  target: RuntimeTarget,
  options: GelIRCompileOptions,
  deps: SqlLoweringContext,
): string | null => {
  const unwrapped = deps.unwrapSelectExprSet(path).result;
  if (unwrapped.expr.kind === "function_call") {
    const call = unwrapped.expr as FunctionCall;
    const shortName = (call.functionName ?? "").split("::").pop();
    const args = deps.orderedCallArgs(call.args);
    // `count(.grouping)` / `count(.elements)` over a group row — array
    // lengths, not SQL aggregates.
    if (shortName === "count" && args.length === 1) {
      let inner: Set = args[0].expr;
      while (inner.expr.kind === "select_expr") {
        inner = (inner.expr as SelectExpr).result;
      }
      if (inner.expr.kind === "group_row_field"
        && (inner.expr as GroupRowFieldExpr).steps.length === 1
        && ((inner.expr as GroupRowFieldExpr).steps[0] === "grouping" || (inner.expr as GroupRowFieldExpr).steps[0] === "elements")) {
        const raw = `${alias}.${quoteIdent("value")}`;
        const field = (inner.expr as GroupRowFieldExpr).steps[0];
        return `json_array_length(COALESCE(json_extract(${raw}, '$."${field}"'), '[]'))`;
      }
    }
    if (shortName === "array_agg" && args.length === 1) {
      let inner: Set = args[0].expr;
      while (inner.expr.kind === "select_expr") {
        inner = (inner.expr as SelectExpr).result;
      }
      if (inner.expr.kind === "group_row_field"
        && (inner.expr as GroupRowFieldExpr).steps.length === 1
        && (inner.expr as GroupRowFieldExpr).steps[0] === "grouping") {
        // Array ordering, not JSON-text ordering: join the sorted names with
        // a separator below any name character so `[]` sorts before
        // `["element"]` and prefixes sort before their extensions.
        const raw = `${alias}.${quoteIdent("value")}`;
        return `COALESCE((SELECT group_concat(je.${quoteIdent("value")}, char(1))`
          + ` FROM (SELECT ${quoteIdent("value")} FROM json_each(COALESCE(json_extract(${raw}, '$."grouping"'), '[]')) ORDER BY ${quoteIdent("value")}) je), '')`;
      }
    }
  }
  return deps.compileValueSetSQL(path, alias, params, target, options);
};
