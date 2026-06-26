// Tracer bullet for the qlast-based AST→IR port.
//
// A faithful, structure-preserving port of Gel's
// `edb/edgeql/compiler/setgen.py::compile_path` (setgen.py:321) — the function
// that turns an EdgeQL path expression into an `ir.Set` — but consuming the
// grammar-faithful `qlast.ts` AST instead of the bespoke `ast.ts`, and producing
// the existing Live IR `Set` from `gel_ir.ts`.
//
// PURPOSE: measure how clean the Python→TS transcription becomes once the AST
// node shapes match Gel 1:1. The control flow below is a near-line-for-line
// mirror of `compile_path`; the only substitutions are the schema/IR calls,
// which bind to the EXISTING sqlite-ts helpers (`resolveTypeRef`,
// `resolvePointerRef`, `extendPathSetDirectional`, …) re-exported from
// `ast_to_ir.ts`. Wherever Gel reaches into machinery sqlite-ts hasn't grown a
// home for yet (schema views, materialization, scope-tree surgery,
// link-property force-table), the step is marked DEFERRED with its upstream
// `setgen.py` reference rather than faked.
//
// NOT WIRED into the live compiler — the parser still emits `ast.ts`. This file
// exists only to validate the porting approach against real schema + IR. See
// the migration plan: parser→qlast, then migrate `ast_to_ir.ts` piecewise.

import type {
  Path as QlPath,
  Ptr as QlPtr,
  ObjectRef as QlObjectRef,
  TypeIntersection as QlTypeIntersection,
  SpecialAnchor as QlSpecialAnchor,
  IRAnchor as QlIRAnchor,
  TypeExpr as QlTypeExpr,
  TypeName as QlTypeName,
} from "../edgeql/qlast.js";
import type { Set as IRSet } from "../ir/gel_ir.js";
import {
  type IRCompileContext,
  resolveTypeRef,
  setFromTypeRoot,
  resolvePointerRef,
  extendPathSetDirectional,
  resolveBinding,
} from "./ast_to_ir.js";

const kindOf = (node: unknown): string | undefined =>
  (node as { __kind__?: string } | null | undefined)?.__kind__;

// `module::Name` qualification for a qlast ObjectRef root.
const qualifyObjectRef = (ref: QlObjectRef): string =>
  ref.module ? `${ref.module}::${ref.name}` : ref.name;

// Pull a type name out of a qlast TypeExpr for an `[IS T]` intersection step —
// the data ast.ts flattens onto its `type_intersection` step's `typeName`.
const typeExprName = (typeExpr: QlTypeExpr): string => {
  if (typeExpr.name) return typeExpr.name;
  if (kindOf(typeExpr) === "TypeName") {
    const main = (typeExpr as QlTypeName).maintype as { name?: string; module?: string };
    if (main?.name) return main.module ? `${main.module}::${main.name}` : main.name;
  }
  throw new Error(`cannot resolve a type name from TypeExpr '${kindOf(typeExpr)}'`);
};

/**
 * Port of `edb/edgeql/compiler/setgen.py::compile_path` — build the Live IR
 * `Set` for an EdgeQL path expression from a grammar-faithful qlast `Path`.
 */
export const compilePathQlast = (expr: QlPath, ctx: IRCompileContext): IRSet => {
  let pathTip: IRSet | undefined;

  // setgen.py:325-358 — partial path (`.foo`). Gel uses `ctx.partial_path_prefix`;
  // sqlite-ts threads the surrounding subject in as the `__current__` /
  // `__subject__` binding (the same fallback `ast_to_ir.compilePathSteps` uses),
  // so resolve against that. DEFERRED: the rich "did you mean…" anchor hint.
  if (expr.partial) {
    pathTip = resolveBinding(ctx, "__current__") ?? resolveBinding(ctx, "__subject__");
    if (!pathTip) {
      throw new Error("could not resolve partial path");
    }
  }

  // setgen.py:363 — walk the steps, dispatching on node kind.
  for (let i = 0; i < expr.steps.length; i += 1) {
    const step = expr.steps[i];
    const kind = kindOf(step);

    // setgen.py:367-368 — SpecialAnchor (`__subject__`, `__source__`, …).
    if (kind === "SpecialAnchor") {
      const anchor = step as QlSpecialAnchor;
      pathTip = resolveBinding(ctx, anchor.name);
      if (!pathTip) throw new Error(`anchor ${anchor.name} is missing`);
      continue;
    }

    // setgen.py:370-386 — IRAnchor (a named anchor already in scope).
    if (kind === "IRAnchor") {
      const anchor = step as QlIRAnchor;
      pathTip = resolveBinding(ctx, anchor.name);
      if (!pathTip) throw new Error(`anchor ${anchor.name} is missing`);
      // DEFERRED (setgen.py:377-386): `move_scope` reparents the anchor's
      // path-scope node. Needs the scope tree live in the compile context.
      continue;
    }

    // setgen.py:388-447 — ObjectRef, only valid as the first step.
    if (kind === "ObjectRef") {
      if (i > 0) {
        throw new Error("unexpected ObjectRef as a non-first path item");
      }
      const ref = step as QlObjectRef;
      // A WITH-/FOR-bound name (or anchor) resolves to an existing Set; an
      // unbound name is a fresh type-root extent (`Movie` → SELECT FROM Movie).
      const bound = !ref.module ? resolveBinding(ctx, ref.name) : undefined;
      // DEFERRED (setgen.py:405-447): enum-path detection, schema-view
      // declaration (`declare_view_from_schema`), WITH/inline `view_sets`
      // lookup, and `maybe_materialize`. The tracer bullet covers the
      // type-root and binding cases that dominate real queries.
      pathTip = bound ?? setFromTypeRoot(resolveTypeRef(ctx, qualifyObjectRef(ref)));
      continue;
    }

    // setgen.py:449-… — Ptr (a pointer-traversal step).
    if (kind === "Ptr") {
      const ptr = step as QlPtr;
      if (!pathTip) {
        throw new Error(`pointer '${ptr.name}' has no source set`);
      }
      // setgen.py:462-515 — link-property steps (`@prop`). DEFERRED: Gel walks
      // back to the preceding link's ptrref and sets `force_link_table`, with
      // visibility checks. sqlite-ts handles these in `PathId.extend` today.
      if (ptr.type === "property" || ptr.name.startsWith("@")) {
        throw new Error(`DEFERRED: link-property step '${ptr.name}' (setgen.py:462)`);
      }
      const direction =
        ptr.direction === "<" || ptr.direction === "inbound" ? "inbound" : "outbound";
      const ptrref = resolvePointerRef(ctx, pathTip.typeref, ptr.name);
      if (!ptrref) {
        // setgen.py raises InvalidReferenceError here. DEFERRED: computed-
        // property in-place lowering (ast_to_ir compilePathSteps:1870-1880).
        throw new Error(`unknown pointer '${ptr.name}' on '${pathTip.typeref.nameHint}'`);
      }
      pathTip = extendPathSetDirectional(
        pathTip,
        ptrref,
        ptrref.computedLinkAliasIsBackward ? "inbound" : direction,
      );
      continue;
    }

    // Path-level `[IS T]` narrowing.
    if (kind === "TypeIntersection") {
      const ti = step as QlTypeIntersection;
      if (!pathTip) throw new Error("type intersection has no source set");
      const intersected = resolveTypeRef(ctx, typeExprName(ti.type));
      // DEFERRED: operand validation + true closure narrowing
      // (ast_to_ir compilePathSteps:1898-1910). Tracer bullet re-types the tip.
      pathTip = { ...pathTip, typeref: intersected };
      continue;
    }

    // `*` / `**` are expanded by viewgen inside shapes; as a bare path step
    // there is nothing to traverse. DEFERRED.
    if (kind === "Splat") continue;

    throw new Error(`unsupported qlast path step '${kind}'`);
  }

  if (!pathTip) {
    throw new Error("empty path expression");
  }
  return pathTip;
};
