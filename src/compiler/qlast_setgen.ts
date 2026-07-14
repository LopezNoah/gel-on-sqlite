// qlast-consuming path compiler — a faithful port of Gel's
// `edb/edgeql/compiler/setgen.py::compile_path`, consuming the grammar-faithful
// `qlast.ts` AST and producing the Live IR `Set` (`gel_ir.ts`).
//
// It mirrors the live `compilePathSteps` (ast_to_ir.ts) case-for-case, reusing
// the SAME schema/IR helpers via an injected `QlastPathDeps` bundle (the ADR
// dependency-seam pattern) so its output is identical to the legacy compiler
// for the ported cases. Cases not yet ported (computed-property in-place
// lowering, group-row fields, named-tuple access, polymorphic link properties)
// throw a tagged `QLAST_DEFERRED` error; the gate in `compileFreeObjectExpr`
// catches it and falls back to the legacy path compiler. Coverage grows by
// converting `DEFERRED` cases into real ports, each guarded by the differential
// parity harness (tests/qlast_path_parity.test.ts).

import type {
  IRAnchor as QlIRAnchor,
  ObjectRef as QlObjectRef,
  Path as QlPath,
  Ptr as QlPtr,
  SpecialAnchor as QlSpecialAnchor,
  TypeExpr as QlTypeExpr,
  TypeIntersection as QlTypeIntersection,
  TypeName as QlTypeName,
} from "../edgeql/qlast.js";
import type { Pointer, PointerRef, Set as IRSet, TypeRef, TypeRoot } from "../ir/gel_ir.js";
import type { IRCompileContext } from "./ast_to_ir.js";

// The schema/IR helper kit `compilePathQlast` needs, injected from ast_to_ir.ts
// (where these are defined) to avoid duplicating them and to guarantee the
// emitted IR matches the legacy compiler exactly. `getResolvedSchemaType` is
// typed structurally for the only fields the link-property port reads.
export interface QlastPathDeps {
  resolveBinding: (ctx: IRCompileContext, name: string) => IRSet | undefined;
  setFromTypeRoot: (typeref: TypeRef) => IRSet;
  resolveTypeRef: (ctx: IRCompileContext, name: string) => TypeRef;
  resolvePointerRef: (ctx: IRCompileContext, source: TypeRef, field: string) => PointerRef | undefined;
  resolveBacklinkPointerRef: (
    ctx: IRCompileContext,
    target: TypeRef,
    linkName: string,
    sourceTypeName?: string,
  ) => PointerRef | undefined;
  extendPathSetDirectional: (source: IRSet, ptrref: PointerRef, direction: "outbound" | "inbound") => IRSet;
  extendPathSet: (source: IRSet, ptrref: PointerRef) => IRSet;
  synthesizeTypePointerSet: (source: IRSet) => IRSet;
  synthesizeTypeNamePointerSet: (typeSet: IRSet) => IRSet;
  validateTypeIntersectionOperand: (ctx: IRCompileContext, baseRef: TypeRef, targetRef: TypeRef) => void;
  validateTypeIntersectionPointer: (
    ctx: IRCompileContext,
    baseTypeId: string,
    intersectTypeId: string,
    ptrName: string,
  ) => void;
  narrowTypeIntersectionSet: (ctx: IRCompileContext, source: IRSet, typeName: string) => IRSet;
  lookupEnumScalar: (ctx: IRCompileContext, name: string) => { qualifiedName: string; members: string[] } | undefined;
  resolvePathToEnumLiteral: (ctx: IRCompileContext, head: string, tail: string | undefined) => IRSet | undefined;
  literalToSet: (value: string | number | boolean | null) => IRSet;
  failSemantic: (message: string) => never;
  scalarTypeRef: (scalar: string) => TypeRef;
  getResolvedSchemaType: (
    ctx: IRCompileContext,
    qualifiedName: string,
  ) =>
    | { resolvedLinks: ReadonlyArray<{ name: string; properties?: ReadonlyArray<{ name: string; type: string; required?: boolean }> }> }
    | undefined;
}

const QLAST_DEFERRED = "QLAST_DEFERRED";
const deferred = (reason: string): Error => new Error(`${QLAST_DEFERRED}: ${reason}`);
/** True for the tagged error compilePathQlast throws on a not-yet-ported case. */
export const isQlastDeferred = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(QLAST_DEFERRED);

const kindOf = (node: unknown): string | undefined =>
  (node as { __kind__?: string } | null | undefined)?.__kind__;

const qualifyObjectRef = (ref: QlObjectRef): string =>
  ref.module ? `${ref.module}::${ref.name}` : ref.name;

const typeExprName = (typeExpr: QlTypeExpr): string => {
  if (typeExpr.name) return typeExpr.name;
  if (kindOf(typeExpr) === "TypeName") {
    const main = (typeExpr as QlTypeName).maintype as { name?: string; module?: string };
    if (main?.name) return main.module ? `${main.module}::${main.name}` : main.name;
  }
  throw deferred(`cannot resolve a type name from TypeExpr '${kindOf(typeExpr)}'`);
};

// `@prop` step. Faithful port of the single-link case in the live field_access
// handler (ast_to_ir.ts): build a link-property PointerRef off the preceding
// link pointer and extend. Polymorphic (union) links are deferred to legacy.
const compileLinkPropertyStep = (
  linkSet: IRSet,
  propName: string,
  ctx: IRCompileContext,
  deps: QlastPathDeps,
): IRSet => {
  if (linkSet.expr.kind !== "pointer") throw deferred(`link property '@${propName}' on a non-pointer source`);
  const linkPointer = linkSet.expr as Pointer;
  if (linkPointer.ptrref.isLinkProperty) throw deferred(`nested link property '@${propName}'`);
  if (linkPointer.ptrref.unionComponents?.length) throw deferred(`polymorphic link property '@${propName}'`);

  const linkOwnerTypeRef = linkPointer.direction === "inbound"
    ? linkPointer.ptrref.outSource
    : linkPointer.source.typeref;
  const linkDef = deps
    .getResolvedSchemaType(ctx, linkOwnerTypeRef.id)
    ?.resolvedLinks.find((candidate) => candidate.name === linkPointer.ptrref.shortName);
  if (!linkDef) throw deferred(`link-property owner type '${linkOwnerTypeRef.id}' not resolved`);

  const propDef = linkDef.properties?.find((property) => property.name === propName);
  if (!propDef) {
    deps.failSemantic(`link '${linkPointer.ptrref.shortName}' has no property '${propName}'`);
  }

  const propertyPtrRef: PointerRef = {
    kind: "pointer_ref",
    id: `${linkPointer.ptrref.id}.@${propName}`,
    name: `@${propName}`,
    shortName: `@${propName}`,
    outSource: linkSet.typeref,
    outTarget: deps.scalarTypeRef(propDef.type),
    outCardinality: propDef.required ? "one" : "at_most_one",
    inCardinality: "many",
    isComputed: false,
    isLinkProperty: true,
    hasProperties: false,
  };
  return deps.extendPathSet(linkSet, propertyPtrRef);
};

/**
 * Port of `edb/edgeql/compiler/setgen.py::compile_path` — build the Live IR
 * `Set` for an EdgeQL path expression from a grammar-faithful qlast `Path`.
 * Throws `QLAST_DEFERRED` for cases not yet ported (caller falls back).
 */
export const compilePathQlast = (expr: QlPath, ctx: IRCompileContext, deps: QlastPathDeps): IRSet => {
  const steps = expr.steps;

  // Enum path: `EnumType.MEMBER` — the first ObjectRef names an enum scalar and
  // resolves to a member literal, not a traversal. (setgen.py compile_enum_path)
  const first = steps[0];
  if (first && kindOf(first) === "ObjectRef") {
    const ref = first as QlObjectRef;
    if (!deps.resolveBinding(ctx, ref.name)) {
      const enumInfo = deps.lookupEnumScalar(ctx, ref.name);
      // Only OUTBOUND member access (`Enum.MEMBER`) is an enum literal. A
      // backlink (`Enum.<x`, an inbound Ptr) is not a member — defer it so the
      // legacy compiler raises "enum types do not support backlink".
      const firstPtr = steps.slice(1).find((step) => kindOf(step) === "Ptr") as QlPtr | undefined;
      const isBacklink = firstPtr?.direction === "<" || firstPtr?.direction === "inbound";
      if (enumInfo && !isBacklink) {
        const ptrSteps = steps.slice(1).filter((step) => kindOf(step) === "Ptr") as QlPtr[];
        if (ptrSteps.length === 0) {
          deps.failSemantic(`enum path expression lacks an enum member name, as in '${ref.name}.${enumInfo.members[0]}'`);
        }
        if (ptrSteps.length > 1) {
          deps.failSemantic(`invalid property reference on an expression of primitive type`);
        }
        return deps.resolvePathToEnumLiteral(ctx, ref.name, ptrSteps[0].name) ?? deps.literalToSet(null);
      }
    }
  }

  let pathTip: IRSet | undefined;

  // setgen.py:325-358 — partial path (`.foo`): resolve against the surrounding
  // subject (the `__current__` / `__subject__` binding).
  if (expr.partial) {
    pathTip = deps.resolveBinding(ctx, "__current__") ?? deps.resolveBinding(ctx, "__subject__");
    if (!pathTip) throw deferred("partial path with no subject in scope");
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const kind = kindOf(step);

    if (kind === "SpecialAnchor" || kind === "IRAnchor") {
      const name = (step as QlSpecialAnchor | QlIRAnchor).name;
      pathTip = deps.resolveBinding(ctx, name);
      if (!pathTip) throw new Error(`anchor ${name} is missing`);
      continue;
    }

    if (kind === "ObjectRef") {
      if (i > 0) throw new Error("unexpected ObjectRef as a non-first path item");
      const ref = step as QlObjectRef;
      const bound = !ref.module ? deps.resolveBinding(ctx, ref.name) : undefined;
      if (bound) {
        // A binding whose value carries a query shape (`WITH U := SELECT X {…}`)
        // may expose shape-computed pointers (`U.deck.a` where `a := …`) that
        // are not in the schema; the legacy compiler resolves those specially.
        // Defer such binding-rooted paths rather than mis-resolve them.
        if (bound.expr.kind === "select_expr" || (bound.shape?.length ?? 0) > 0) {
          throw deferred(`binding '${ref.name}' carries a query shape — legacy handles shape-computed access`);
        }
        pathTip = bound;
      } else {
        // DEFERRED (setgen.py:405-447): schema/inline views + maybe_materialize.
        pathTip = deps.setFromTypeRoot(deps.resolveTypeRef(ctx, qualifyObjectRef(ref)));
      }
      continue;
    }

    if (kind === "Ptr") {
      const ptr = step as QlPtr;
      if (!pathTip) throw new Error(`pointer '${ptr.name}' has no source set`);

      // Link property (`@prop`): `type === 'property'` in Gel; the bridge also
      // carries it as an `@`-prefixed name.
      if (ptr.type === "property" || ptr.name.startsWith("@")) {
        pathTip = compileLinkPropertyStep(pathTip, ptr.name.replace(/^@/, ""), ctx, deps);
        continue;
      }

      // `__type__` — synthesize the schema::ObjectType pointer (no schema ptr).
      if (ptr.name === "__type__") {
        pathTip = deps.synthesizeTypePointerSet(pathTip);
        continue;
      }
      // `.name` on a synthesized `__type__` pointer.
      if (
        ptr.name === "name"
        && pathTip.expr.kind === "pointer"
        && (pathTip.expr as Pointer).ptrref.shortName === "__type__"
      ) {
        pathTip = deps.synthesizeTypeNamePointerSet(pathTip);
        continue;
      }

      // Backlink (`.<link[IS T]`): an inbound traversal. The source type filter
      // comes from the FOLLOWING `[IS T]` step (the bridge emits Ptr + a
      // TypeIntersection); resolve via the backlink resolver and traverse
      // inbound — matching the live backlink_path / for_expr compilation.
      const direction = ptr.direction === "<" || ptr.direction === "inbound" ? "inbound" : "outbound";
      if (direction === "inbound") {
        const next = steps[i + 1];
        const sourceType = next && kindOf(next) === "TypeIntersection"
          ? typeExprName((next as QlTypeIntersection).type)
          : undefined;
        // Only the TYPED backlink off an OBJECT source matches the live simple
        // backlink branch (for_expr handler). Untyped backlinks carry BaseObject
        // semantics, and scalar/enum sources raise a dedicated error — both have
        // special legacy handling, so defer them to the legacy compiler.
        if (!sourceType || pathTip.typeref.isScalar) {
          throw deferred(`backlink '<${ptr.name}' (untyped or scalar source) — legacy handles`);
        }
        const backlinkRef = deps.resolveBacklinkPointerRef(ctx, pathTip.typeref, ptr.name, sourceType);
        if (!backlinkRef) throw deferred(`unresolved backlink '<${ptr.name}'`);
        pathTip = deps.extendPathSetDirectional(pathTip, backlinkRef, "inbound");
        continue;
      }

      // A real property/link reference on a primitive is invalid.
      if (pathTip.typeref.isScalar && ptr.name !== "id" && ptr.name !== "__type__") {
        deps.failSemantic(`invalid property reference on an expression of primitive type`);
      }

      let ptrref = deps.resolvePointerRef(ctx, pathTip.typeref, ptr.name);
      // A `[IS Super]` narrowing keeps the original rows; a pointer the narrowed
      // view lacks resolves against the underlying root type.
      if (!ptrref && pathTip.expr.kind === "type_root" && (pathTip.expr as TypeRoot).typeref.id !== pathTip.typeref.id) {
        ptrref = deps.resolvePointerRef(ctx, (pathTip.expr as TypeRoot).typeref, ptr.name);
      }
      if (!ptrref) {
        // DEFERRED: computed-property in-place lowering / group-row / named-tuple
        // (ast_to_ir compilePathSteps). Legacy handles these via fallback.
        throw deferred(`unresolved pointer '${ptr.name}' on '${pathTip.typeref.nameHint}'`);
      }
      pathTip = deps.extendPathSetDirectional(
        pathTip,
        ptrref,
        ptrref.computedLinkAliasIsBackward ? "inbound" : direction,
      );
      continue;
    }

    if (kind === "TypeIntersection") {
      const typeName = typeExprName((step as QlTypeIntersection).type);
      pathTip = deps.narrowTypeIntersectionSet(ctx, pathTip!, typeName);
      continue;
    }

    if (kind === "Splat") continue;

    throw deferred(`unsupported qlast path step '${kind}'`);
  }

  if (!pathTip) throw new Error("empty path expression");
  return pathTip;
};
