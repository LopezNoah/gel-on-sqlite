#!/usr/bin/env python3
"""Generate src/edgeql/qlast.ts from Gel's real EdgeQL AST (edb/edgeql/ast.py).

This is the AST-layer analogue of scripts/generate-schema-model.ts (which mirrors
gel_ir into model.ts). It introspects the live Python AST node classes the same
way edb/tools/gen_meta_grammars.py imports the grammar, and emits faithful TS
interfaces — ONE `Expr` hierarchy, matching the grammar, not the parser's current
context-specialized expression unions.

Run from the sqlite-ts directory with the repo venv on the path:
    ../.venv/bin/python scripts/generate-qlast.py

Notes on the mapping:
  * Each AST class -> a TS interface; Python inheritance -> `extends`.
  * A synthetic `kind` discriminant (the Python class name) is added to every
    concrete (leaf) node so consumers can narrow discriminated unions, matching
    the `kind: "..."` convention already used in model.ts. This field does NOT
    exist in ast.py.
  * Hidden metadata fields (`span`, `system_comment`) are omitted.
  * StrEnum classes -> TS string-literal union type aliases.
"""

from __future__ import annotations

import enum
import typing
import types as _types
import os
import sys

import edb.edgeql.ast as qlast
import edb.common.ast as _ast


AST_BASE = _ast.AST
NONE_TYPE = type(None)

BUILTIN_MAP = {
    str: "string",
    int: "number",
    float: "number",
    bool: "boolean",
    bytes: "string",
    type(None): "undefined",
    object: "unknown",
    typing.Any: "unknown",
}


def is_ast_node(t: object) -> bool:
    return isinstance(t, type) and issubclass(t, AST_BASE) and t.__module__ == "edb.edgeql.ast"


def is_enum(t: object) -> bool:
    return isinstance(t, type) and issubclass(t, enum.Enum)


# --- collect the universe ---------------------------------------------------

nodes: list[type] = [
    c for c in vars(qlast).values()
    if isinstance(c, type) and issubclass(c, AST_BASE) and c.__module__ == "edb.edgeql.ast"
]
node_set = set(nodes)

# classes that are a base of some other node => non-leaf
non_leaf: set[type] = set()
for c in nodes:
    for b in c.__bases__:
        if b in node_set:
            non_leaf.add(b)

referenced_enums: dict[str, type] = {}


def ts_enum_name(e: type) -> str:
    referenced_enums[e.__name__] = e
    return e.__name__


def _as_array(inner: str) -> str:
    # Postfix `[]` rather than `Array<>` — `Array` is itself an AST node name
    # (the array literal), so the global generic would be shadowed. Parenthesize
    # top-level unions so `(A | B)[]` parses as an array of the union.
    return f"({inner})[]" if " | " in inner else f"{inner}[]"


def map_type(t: object) -> str:
    """Map a resolved Python type / typing construct to a TS type string."""
    if t in BUILTIN_MAP:
        return BUILTIN_MAP[t]

    origin = typing.get_origin(t)

    # Union (typing.Union[...] or PEP 604 X | Y)
    if origin is typing.Union or isinstance(t, _types.UnionType):
        args = [a for a in typing.get_args(t) if a is not NONE_TYPE]
        parts = []
        for a in args:
            m = map_type(a)
            if m not in parts:
                parts.append(m)
        return " | ".join(parts) if parts else "undefined"

    if origin in (list, set, frozenset):
        (inner,) = typing.get_args(t) or (object,)
        return _as_array(map_type(inner))

    if origin is tuple:
        targs = typing.get_args(t)
        # homogeneous variadic tuple[T, ...]
        if len(targs) == 2 and targs[1] is Ellipsis:
            return _as_array(map_type(targs[0]))
        if targs:
            return f"[{', '.join(map_type(a) for a in targs)}]"
        return "unknown[]"

    if origin is dict:
        kt, vt = (typing.get_args(t) or (str, object))[:2]
        return f"Record<{map_type(kt)}, {map_type(vt)}>"

    if is_enum(t):
        return ts_enum_name(t)

    if is_ast_node(t):
        return t.__name__

    # external non-enum types (e.g. common.span.Span) — not grammar content
    if isinstance(t, type):
        return "unknown"

    return "unknown"


def field_is_optional(f) -> bool:
    # A field is optional on the *node* iff its type admits None (`Optional[X]`).
    # A default or factory only makes it constructor-optional — the field is
    # still always present on the built node — so it stays required here. This
    # also keeps subclasses that add a default to an inherited field assignable.
    t = f.type
    args = typing.get_args(t)
    return (typing.get_origin(t) is typing.Union or isinstance(t, _types.UnionType)) and NONE_TYPE in args


def emit_interface(c: type, out: list[str]) -> None:
    bases = [b.__name__ for b in c.__bases__ if b in node_set]
    extends = f" extends {', '.join(bases)}" if bases else ""
    out.append(f"export interface {c.__name__}{extends} {{")

    # discriminant — named `__kind__`, not `kind`, because ast.py uses `kind`
    # as a real field on some nodes (Constant, FuncParamDecl).
    if c not in non_leaf:
        out.append(f'  __kind__: "{c.__name__}";')
    elif not bases:
        # non-leaf root: declare the discriminant field so descendants narrow it
        out.append("  __kind__: string;")

    direct = getattr(c, "_direct_fields", [])
    for f in direct:
        if f.hidden:
            continue
        opt = field_is_optional(f)
        ty = map_type(f.type)
        # strip a redundant trailing `| undefined` since `?` already implies it
        q = "?" if opt else ""
        out.append(f"  {f.name}{q}: {ty};")

    out.append("}")
    out.append("")


def emit_enum(name: str, e: type, out: list[str]) -> None:
    vals = " | ".join(f'"{m.value}"' for m in e)
    src = "qltypes" if "qltypes" in e.__module__ else "ast"
    out.append(f"// {src} enum")
    out.append(f"export type {name} = {vals};")
    out.append("")


# --- render -----------------------------------------------------------------

interfaces: list[str] = []
for c in nodes:
    emit_interface(c, interfaces)

# enums are discovered during interface emission; render them up front
enum_lines: list[str] = []
for name in sorted(referenced_enums):
    emit_enum(name, referenced_enums[name], enum_lines)

header = [
    "// AUTO-GENERATED — do not edit by hand.",
    "// Source of truth: edb/edgeql/ast.py (Gel's real EdgeQL AST).",
    "// Regenerate: ../.venv/bin/python scripts/generate-qlast.py",
    "//",
    f"// {len(nodes)} node interfaces, {len(referenced_enums)} enums.",
    "//",
    "// This mirrors the grammar's single `Expr` hierarchy — unlike the parser's",
    "// current ast.ts, which splits expressions across FilterExpr / ComputedExpr /",
    "// FreeObjectExpr / FunctionCallArgExpr / InsertValue. `kind` is a synthetic",
    "// discriminant (the Python class name); `span`/`system_comment` are omitted.",
    "",
]

output = "\n".join(header + enum_lines + interfaces)

dest = os.path.join(os.path.dirname(__file__), "..", "src", "edgeql", "qlast.ts")
dest = os.path.abspath(dest)
with open(dest, "w") as fh:
    fh.write(output)

print(f"wrote {dest}: {len(nodes)} interfaces, {len(referenced_enums)} enums, {output.count(chr(10))} lines")
