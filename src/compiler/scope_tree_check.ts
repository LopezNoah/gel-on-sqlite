import { AppError } from "../errors.js";
import type {
  Statement,
  FreeObjectExpr,
  ComputedExpr,
  ShapeElement as EdgeQLShapeElement,
  InsertValue,
  FilterExpr,
  OrderExprChain,
  UpdateStatement,
  InsertStatement,
  DeleteStatement,
  SelectExprStatement,
  SelectStatement,
  WithBinding,
} from "../edgeql/ast.js";
import type { SchemaSnapshot } from "../schema/schema.js";
import { qualifiedTypeName } from "../schema/schema.js";
import type { TypeDef } from "../types.js";

const failScope = (message: string, statement?: Pick<Statement, "pos">): never => {
  throw new AppError("E_SEMANTIC", message, statement?.pos?.line ?? 1, statement?.pos?.column ?? 1);
};

interface PathInfo {
  // Sequence of steps. The first step is the root identifier (e.g. "User"),
  // optionally preceded by a sentinel "__current__" entry when the path begins
  // with a relative `.` reference. Subsequent steps are field/link names or
  // link-property accesses prefixed with "@".
  steps: string[];
  // Indicates whether the path begins with a free type/name reference (i.e.
  // `select(Type)` or `binding_ref(Type)`) rather than a relative `.` head.
  freeRoot: boolean;
}

const isLinkProp = (step: string): boolean => step.startsWith("@");

const extractPath = (expr: FreeObjectExpr | ComputedExpr | undefined): PathInfo | undefined => {
  if (!expr) return undefined;
  switch (expr.kind) {
    case "binding_ref":
      return { steps: [expr.name], freeRoot: true };
    case "select":
      // A bare `Type` reference in a free-expression context shows up as a
      // `select` node with the default `{ id }` shape and no clauses. We treat
      // it as equivalent to `binding_ref(Type)` for path-tracking purposes.
      if (
        (!expr.shape || expr.shape.length === 0 || expr.shape.every((el) => el.kind === "field" && (el as { origin?: string }).origin === "default"))
        && (!expr.clauses || (
          expr.clauses.filter === undefined
          && expr.clauses.orderBy === undefined
          && expr.clauses.limit === undefined
          && expr.clauses.offset === undefined
        ))
      ) {
        return { steps: [expr.typeName], freeRoot: true };
      }
      return undefined;
    case "current_item":
      return { steps: ["__current__"], freeRoot: false };
    case "field_access": {
      const base = extractPath(expr.expr);
      if (!base) return undefined;
      return { steps: [...base.steps, expr.field], freeRoot: base.freeRoot };
    }
    case "path": {
      if (!expr.steps?.length) {
        return { steps: [expr.head, expr.tail], freeRoot: true };
      }
      return undefined;
    }
    case "path_chain": {
      if (expr.parts.length > 0) {
        return { steps: [...expr.parts], freeRoot: true };
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

const pathPrefixEquals = (a: string[], b: string[]): boolean => {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const formatPathSteps = (steps: string[]): string => {
  let out = "";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (i === 0) {
      out = step;
    } else if (isLinkProp(step)) {
      out += step;
    } else {
      out += `.${step}`;
    }
  }
  return out;
};

interface SubjectContext {
  rootType: string;
  // The full subject path steps (without the implicit root sentinel).
  subjectSteps: string[];
  // Multi-step means the subject is a path with depth > 1, which triggers
  // scope-tree analysis for inner clauses.
  multiStep: boolean;
  // True iff the subject path contains at least one link step (or an @prop).
  // Following the Python `_node_paths_are_not_links` heuristic: when the
  // subject path only traverses properties, factoring is safe and no scope
  // violation is raised.
  hasLinkStep: boolean;
}

const resolveTypeDef = (schema: SchemaSnapshot | undefined, name: string): TypeDef | undefined => {
  if (!schema) return undefined;
  const direct = schema.getType(name);
  if (direct) return direct;
  for (const t of schema.listTypes()) {
    if (t.name === name) return t;
  }
  return undefined;
};

// Walk type hierarchy collecting fields and links, including those inherited
// from parent types via `extends`.
const collectMember = (
  schema: SchemaSnapshot | undefined,
  type: TypeDef,
  name: string,
  visited: Set<string> = new Set(),
): { kind: "link"; def: NonNullable<TypeDef["links"]>[number] } | { kind: "field" } | undefined => {
  const key = qualifiedTypeName(type);
  if (visited.has(key)) return undefined;
  visited.add(key);

  const link = type.links?.find((l) => l.name === name);
  if (link) return { kind: "link", def: link };
  const field = type.fields.find((f) => f.name === name);
  if (field) return { kind: "field" };

  for (const parentName of type.extends ?? []) {
    const parent = resolveTypeDef(schema, parentName);
    if (parent) {
      const found = collectMember(schema, parent, name, visited);
      if (found) return found;
    }
  }
  return undefined;
};

// `id` is a built-in property on every object type. Some schema layers strip
// it from the `fields` array, so we treat it as a known property regardless.
const isBuiltinProperty = (step: string): boolean => step === "id" || step === "__type__";

const subjectPathHasLink = (
  schema: SchemaSnapshot | undefined,
  steps: string[],
): boolean => {
  if (!schema || steps.length < 2) return false;
  let currentType = resolveTypeDef(schema, steps[0]);
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    if (isLinkProp(step)) {
      // A link property access (@prop) by definition implies the parent step
      // is a link; treat as a link-path.
      return true;
    }
    if (isBuiltinProperty(step)) {
      currentType = undefined;
      continue;
    }
    if (!currentType) return true; // unknown — conservatively assume link
    const member = collectMember(schema, currentType, step);
    if (!member) return true; // unknown step — conservatively assume link
    if (member.kind === "link") {
      const target = member.def.targetType?.split("|")[0]?.trim();
      currentType = target ? resolveTypeDef(schema, target) : undefined;
      return true;
    }
    // Property — keep walking, currentType becomes undefined (scalar)
    currentType = undefined;
  }
  return false;
};

const visitExpr = (
  expr: FreeObjectExpr | ComputedExpr | undefined,
  subj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  stmt: Pick<Statement, "pos">,
): void => {
  if (!expr) return;

  // First, check if THIS expression is itself a path rooted at the subject's
  // type. If so, classify and possibly fail — and don't recurse into its
  // head, since the head is a strict prefix of this same path and would
  // re-trigger spurious "pure root reference" diagnostics.
  if (subj) {
    const path = extractPath(expr);
    if (path && path.freeRoot && path.steps[0] === subj.rootType) {
      classifyAndMaybeFail(path, subj, stmt);
      return;
    }
    if (path) {
      // Path with a different root or relative head — nothing to flag here,
      // and we don't recurse into a path's own head because path prefixes
      // share scope with the full path.
      return;
    }
  }

  switch (expr.kind) {
    case "field_access":
      visitExpr(expr.expr, subj, outerDmlRoot, stmt);
      return;
    case "shape_projection":
      visitExpr(expr.expr, subj, outerDmlRoot, stmt);
      for (const el of expr.shape) {
        visitShapeElement(el, subj, outerDmlRoot, stmt);
      }
      return;
    case "select_expr_subquery":
      // A nested SELECT subquery introduces its own scope, but inner
      // free-references can still violate the outer scope; visit body and
      // clauses with the same subject context (mirroring the Python check
      // which factors paths up through scope boundaries).
      visitExpr(expr.expr, subj, outerDmlRoot, stmt);
      visitExpr(expr.filter, subj, outerDmlRoot, stmt);
      if (expr.orderBy) visitOrderChain(expr.orderBy, subj, outerDmlRoot, stmt);
      if (expr.limitExpr) visitExpr(expr.limitExpr, subj, outerDmlRoot, stmt);
      if (expr.offsetExpr) visitExpr(expr.offsetExpr, subj, outerDmlRoot, stmt);
      return;
    case "select":
      // Don't recurse into a free `select` node's default shape; it's
      // generated by the parser for bare type references. Inner clauses on
      // a parser-generated `select` are uncommon enough that they're left
      // to the main compiler to validate.
      for (const el of expr.shape ?? []) {
        if ((el as { origin?: string }).origin !== "default") {
          visitShapeElement(el, subj, outerDmlRoot, stmt);
        }
      }
      return;
    case "mutation_expr":
      visitMutation(expr.statement, subj, outerDmlRoot, stmt);
      return;
    case "and":
    case "or":
    case "compare":
    case "in_expr":
    case "math":
    case "logical":
    case "coalesce":
      visitExpr(expr.left, subj, outerDmlRoot, stmt);
      visitExpr(expr.right, subj, outerDmlRoot, stmt);
      return;
    case "not":
    case "unary":
    case "distinct":
    case "exists":
    case "cast":
    case "is_type":
      visitExpr(expr.expr, subj, outerDmlRoot, stmt);
      return;
    case "if_else":
      visitExpr(expr.condition, subj, outerDmlRoot, stmt);
      visitExpr(expr.thenExpr, subj, outerDmlRoot, stmt);
      visitExpr(expr.elseExpr, subj, outerDmlRoot, stmt);
      return;
    case "for_expr":
      visitExpr(expr.iterator, subj, outerDmlRoot, stmt);
      visitExpr(expr.body, subj, outerDmlRoot, stmt);
      if (expr.filter) visitExpr(expr.filter, subj, outerDmlRoot, stmt);
      return;
    case "tuple":
    case "set_expr":
    case "array_literal_expr":
      for (const v of expr.values) visitExpr(v, subj, outerDmlRoot, stmt);
      return;
    case "free_object_constructor":
      for (const entry of expr.entries) visitExpr(entry.expr, subj, outerDmlRoot, stmt);
      return;
    case "concat":
      for (const part of expr.parts) visitExpr(part, subj, outerDmlRoot, stmt);
      return;
    case "function_call":
      if (expr.call?.args) {
        for (const a of expr.call.args) {
          if ((a as { expr?: FreeObjectExpr }).expr) {
            visitExpr((a as { expr: FreeObjectExpr }).expr, subj, outerDmlRoot, stmt);
          }
        }
      }
      return;
    case "index_access":
    case "slice_access":
      visitExpr(expr.expr, subj, outerDmlRoot, stmt);
      return;
    default:
      return;
  }
};

const visitOrderChain = (
  chain: OrderExprChain,
  subj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  stmt: Pick<Statement, "pos">,
): void => {
  visitExpr(chain.expr, subj, outerDmlRoot, stmt);
  if (chain.then) visitOrderChain(chain.then, subj, outerDmlRoot, stmt);
};

const visitShapeElement = (
  el: EdgeQLShapeElement,
  subj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  stmt: Pick<Statement, "pos">,
): void => {
  if (el.kind === "computed") {
    const computed = el as { expr?: FreeObjectExpr };
    if (computed.expr) visitExpr(computed.expr, subj, outerDmlRoot, stmt);
  }
  if ((el as { shape?: EdgeQLShapeElement[] }).shape) {
    for (const inner of (el as { shape: EdgeQLShapeElement[] }).shape) {
      visitShapeElement(inner, subj, outerDmlRoot, stmt);
    }
  }
};

const visitInsertValue = (
  value: InsertValue,
  subj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  stmt: Pick<Statement, "pos">,
): void => {
  if ((value as { kind?: string }).kind === "expr") {
    visitExpr((value as { expr: FreeObjectExpr }).expr, subj, outerDmlRoot, stmt);
    return;
  }
  if ((value as { kind?: string }).kind === "set_literal") {
    for (const v of (value as { values: InsertValue[] }).values) {
      visitInsertValue(v, subj, outerDmlRoot, stmt);
    }
    return;
  }
  if ((value as { kind?: string }).kind === "array_literal") {
    for (const v of (value as { values: InsertValue[] }).values) {
      visitInsertValue(v, subj, outerDmlRoot, stmt);
    }
    return;
  }
};

const visitMutation = (
  mut: UpdateStatement | InsertStatement | DeleteStatement,
  outerSubj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  outerStmt: Pick<Statement, "pos">,
): void => {
  if (mut.kind === "update" || mut.kind === "delete") {
    // bad_06 case: an inner DML whose subject refers to the outer DML's
    // subject set (e.g. `UPDATE .avatar` inside `UPDATE User`) is a
    // correlated-set reference and must be rejected.
    if (outerDmlRoot) {
      const targetPath = extractPath((mut as UpdateStatement | DeleteStatement).target);
      if (targetPath && !targetPath.freeRoot && targetPath.steps[0] === "__current__") {
        failScope(
          `cannot reference correlated set '${outerDmlRoot}' here`,
          { pos: mut.pos },
        );
      }
    }

    // Recurse into the inner DML body with its own DML root context. Inner
    // scope-tree analysis on the inner DML itself is handled by the regular
    // dispatch below.
    validateStatement(mut as Statement, activeSchema);
    return;
  }

  if (mut.kind === "insert") {
    validateStatement(mut as Statement, activeSchema);
    return;
  }
};

const classifyAndMaybeFail = (
  innerPath: PathInfo,
  subj: SubjectContext,
  stmt: Pick<Statement, "pos">,
): void => {
  if (!subj.multiStep) return;
  // If the subject path only traverses scalar properties (not links), the
  // Python compiler factors the references into a single common scope and
  // emits no diagnostic. Mirror that here.
  if (!subj.hasLinkStep) return;

  // Identity case: inner path equals subject path exactly (e.g., a SELECT
  // of `User.deck` whose ORDER BY also says `User.deck`). That's allowed
  // because the path id resolves to the same scope.
  if (
    innerPath.steps.length === subj.subjectSteps.length
    && pathPrefixEquals(innerPath.steps, subj.subjectSteps)
  ) {
    return;
  }

  // Extension of the subject path. If inner == subject + [more steps], the
  // extension only introduces a new violation if the very next step is a
  // link-property access (@prop), which reopens an implicit set on the link
  // source. Plain property/link extensions are fine — they refine the
  // existing scope.
  if (
    innerPath.steps.length > subj.subjectSteps.length
    && pathPrefixEquals(subj.subjectSteps, innerPath.steps)
  ) {
    const nextStep = innerPath.steps[subj.subjectSteps.length];
    if (isLinkProp(nextStep)) {
      failScope(
        `reference to '${subj.rootType}' changes the interpretation of '${subj.rootType}' elsewhere in the query`,
        stmt,
      );
    }
    return;
  }

  // Pure root reference (just the type name).
  if (innerPath.steps.length === 1) {
    failScope(
      `reference to '${subj.rootType}' changes the interpretation of '${subj.rootType}' elsewhere in the query`,
      stmt,
    );
  }

  // Different branch from the subject — report the full offending path.
  failScope(
    `reference to '${formatPathSteps(innerPath.steps)}' changes the interpretation of '${subj.rootType}' elsewhere in the query`,
    stmt,
  );
};

const subjectContextFor = (
  subjectExpr: FreeObjectExpr | undefined,
  schema: SchemaSnapshot | undefined,
  fallbackRoot?: string,
): SubjectContext | undefined => {
  const path = subjectExpr ? extractPath(subjectExpr) : undefined;
  if (!path && fallbackRoot) {
    return { rootType: fallbackRoot, subjectSteps: [fallbackRoot], multiStep: false, hasLinkStep: false };
  }
  if (!path) return undefined;
  const multiStep = path.steps.length > 1 || path.steps.some(isLinkProp);
  const hasLinkStep = subjectPathHasLink(schema, path.steps);
  return { rootType: path.steps[0], subjectSteps: path.steps, multiStep, hasLinkStep };
};

const validateSelectExpr = (statement: SelectExprStatement, schema: SchemaSnapshot | undefined): void => {
  let subjectExpr: FreeObjectExpr | undefined = statement.expr;
  let clauseExprs: FreeObjectExpr[] = [];
  let shape: EdgeQLShapeElement[] = [];

  // Unwrap a single select_expr_subquery wrapper into subject + clauses.
  if (subjectExpr?.kind === "select_expr_subquery") {
    const sub = subjectExpr;
    subjectExpr = sub.expr;
    if (sub.filter) clauseExprs.push(sub.filter);
    if (sub.limitExpr) clauseExprs.push(sub.limitExpr);
    if (sub.offsetExpr) clauseExprs.push(sub.offsetExpr);
  }

  // Unwrap a shape_projection: subject is the inner expr, shape elements are
  // computed inner clauses.
  if (subjectExpr?.kind === "shape_projection") {
    shape = subjectExpr.shape;
    subjectExpr = subjectExpr.expr;
  }

  const subj = subjectContextFor(subjectExpr, schema);
  if (!subj || !subj.multiStep) return;

  for (const clause of clauseExprs) {
    visitExpr(clause, subj, undefined, statement);
  }
  for (const el of shape) {
    visitShapeElement(el, subj, undefined, statement);
  }
};

const validateSelect = (statement: SelectStatement, schema: SchemaSnapshot | undefined): void => {
  const subj = subjectContextFor(undefined, schema, statement.typeName);
  if (!subj) return;
  // SelectStatement form already starts from a type name; not a multi-step
  // subject, so nothing to check at this layer.
};

const validateUpdate = (statement: UpdateStatement, schema: SchemaSnapshot | undefined): void => {
  // First: outer subject context for "changes the interpretation" detection.
  const subjectExpr = statement.target;
  const subj = subjectContextFor(subjectExpr, schema, statement.typeName);
  if (subj?.multiStep) {
    for (const [, value] of Object.entries(statement.values)) {
      visitInsertValue(value, subj, undefined, statement);
    }
    if (statement.filter) {
      visitFilter(statement.filter, subj, undefined, statement);
    }
  }

  // Always: nested-DML correlated-set check. Any inner mutation_expr in a
  // SET value whose target is a relative path is rejected as referencing
  // the outer correlated subject.
  const dmlRoot = subj?.rootType ?? statement.typeName;
  for (const [, value] of Object.entries(statement.values)) {
    visitInsertValue(value, undefined, dmlRoot, statement);
  }
};

const visitFilter = (
  filter: FilterExpr,
  subj: SubjectContext | undefined,
  outerDmlRoot: string | undefined,
  stmt: Pick<Statement, "pos">,
): void => {
  if (filter.kind === "free_expr") {
    visitExpr(filter.expr, subj, outerDmlRoot, stmt);
    return;
  }
  if (filter.kind === "and" || filter.kind === "or") {
    visitFilter(filter.left, subj, outerDmlRoot, stmt);
    visitFilter(filter.right, subj, outerDmlRoot, stmt);
    return;
  }
  if (filter.kind === "not") {
    visitFilter(filter.expr, subj, outerDmlRoot, stmt);
    return;
  }
};

const validateStatement = (statement: Statement, schema: SchemaSnapshot | undefined): void => {
  switch (statement.kind) {
    case "select_expr":
      validateSelectExpr(statement, schema);
      return;
    case "select":
      validateSelect(statement, schema);
      return;
    case "update":
      validateUpdate(statement, schema);
      return;
    default:
      return;
  }
};

let activeSchema: SchemaSnapshot | undefined;

export const checkScopeTreeViolations = (statement: Statement, schema?: SchemaSnapshot): void => {
  const prev = activeSchema;
  if (schema) activeSchema = schema;
  try {
    validateStatement(statement, activeSchema);
  } finally {
    activeSchema = prev;
  }
};
