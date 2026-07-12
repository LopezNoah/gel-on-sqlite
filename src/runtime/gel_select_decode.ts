// Bundle-safe decode-option derivation for the lowered SELECT path.
//
// `materializeGelSQLRows` needs facts about the compiled statement: whether the
// top-level shape projects `id` (keepInternalId) and whether scalar results need
// type-specific decoding. The canonical copies
// of these tiny pure helpers live in `engine.ts`, but that module pulls in
// `database.ts` → `better-sqlite3` and so can't be imported by the async/D1
// path (it must bundle for workerd). These mirror the engine versions exactly,
// operating only on the native-free `gel_ir` types.
//
// TODO(d1): once the async path lands, promote this module to the canonical
// home and have engine.ts import from here, eliminating the duplication. Kept
// separate for now to avoid editing engine.ts while another agent has it open.

import type {
  Set as GelIRSet,
  ShapeElement as GelIRShapeElement,
  Statement as GelIRStatement,
  TypeRef as GelIRTypeRef,
} from "../ir/gel_ir.js";

const unwrapGelSelectResultSet = (set: GelIRSet): GelIRSet => {
  let current = set;
  while (current.expr.kind === "select_expr") {
    const result = (current.expr as { result?: GelIRSet }).result;
    if (!result) break;
    current = result;
  }
  return current;
};

const topLevelGelShape = (statement: GelIRStatement): GelIRShapeElement[] =>
  unwrapGelSelectResultSet(statement.expr).shape ?? [];

const gelShapeElementName = (element: GelIRShapeElement): string | undefined => {
  if (element.name) return element.name;
  if (element.targetPtr?.shortName) return element.targetPtr.shortName;
  const expr = element.expr.expr as { ptrref?: { shortName?: string } };
  return expr.ptrref?.shortName;
};

const qualifiedGelTypeName = (typeref: GelIRTypeRef): string =>
  typeref.nameHint.includes("::") ? typeref.nameHint : `${typeref.module}::${typeref.nameHint}`;

const gelStatementProjectsId = (statement: GelIRStatement): boolean =>
  topLevelGelShape(statement).some((element) => gelShapeElementName(element) === "id");

const gelStatementScalarResultIsStr = (statement: GelIRStatement): boolean => {
  const typeref = unwrapGelSelectResultSet(statement.expr).typeref;
  if (!typeref) return false;
  return qualifiedGelTypeName(typeref) === "std::str";
};

const gelStatementScalarResultIsBool = (statement: GelIRStatement): boolean => {
  const typeref = unwrapGelSelectResultSet(statement.expr).typeref;
  if (!typeref) return false;
  return qualifiedGelTypeName(typeref) === "std::bool";
};

// The qualified name of the object type a SELECT reads from, or undefined for
// scalar/free selects. Used to gate access-policy enforcement off the async
// path (policy evaluation re-queries per row — a Tier-2 concern).
export const gelStatementSourceType = (statement: GelIRStatement): string | undefined => {
  const typeref = unwrapGelSelectResultSet(statement.expr).typeref;
  if (!typeref || typeref.isScalar) return undefined;
  return qualifiedGelTypeName(typeref);
};

export interface GelSelectDecodeOptions {
  keepInternalId: boolean;
  scalarResultIsStr: boolean;
  scalarResultIsBool: boolean;
}

export const gelSelectDecodeOptions = (statement: GelIRStatement): GelSelectDecodeOptions => ({
  keepInternalId: gelStatementProjectsId(statement),
  scalarResultIsStr: gelStatementScalarResultIsStr(statement),
  scalarResultIsBool: gelStatementScalarResultIsBool(statement),
});
