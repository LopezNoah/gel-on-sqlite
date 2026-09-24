"""Exploratory bridge from Gel's grammar-backed parser to sqlite-ts's AST.

Input: JSON array of EdgeQL strings on stdin. Output: JSON array of verdicts.
Run through grammar-spike.ts, which supplies the local Gel Python environment.
This is deliberately strict: an unmapped Gel AST is reported, never guessed.
"""

import json
import sys

from edb import errors
from edb.edgeql import ast as qlast
from edb.edgeql import parser


class Unmapped(Exception):
    pass


def require(condition, description):
    if not condition:
        raise Unmapped(description)


def expression(node):
    if isinstance(node, qlast.Constant):
        require(node.kind.value in ("INTEGER", "FLOAT", "STRING"),
                f"constant {node.kind}")
        if node.kind.value == "STRING":
            return {"kind": "literal", "value": node.value}
        return {
            "kind": "literal",
            "value": float(node.value) if node.kind.value == "FLOAT" else int(node.value),
            "numericKind": node.kind.value.lower(),
        }
    if isinstance(node, qlast.BinOp):
        require(node.op in ("+", "-", "*", "/"), f"operator {node.op}")
        return {
            "kind": "math", "op": node.op,
            "left": expression(node.left), "right": expression(node.right),
        }
    raise Unmapped(f"expression {type(node).__name__}")


def bare_name(node):
    require(isinstance(node, qlast.Path) and not node.partial
            and len(node.steps) == 1 and isinstance(node.steps[0], qlast.ObjectRef),
            "expected unqualified type name")
    require(node.steps[0].module is None, "qualified type name")
    return node.steps[0].name


def field_name(node, partial):
    require(isinstance(node, qlast.Path) and node.partial == partial
            and len(node.steps) == 1 and isinstance(node.steps[0], qlast.Ptr),
            "expected single field path")
    require(node.steps[0].direction.name == "Outbound", "inbound field")
    return node.steps[0].name


def select(node):
    require(isinstance(node, qlast.SelectQuery), f"statement {type(node).__name__}")
    require(not node.aliases and node.result_alias is None and not node.orderby
            and node.offset is None and node.limit is None, "SELECT clauses")
    # The fixture uses ASCII, so Gel's byte offset is also a character offset.
    result = node.result
    if isinstance(result, qlast.Shape):
        type_name = bare_name(result.expr)
        shape = []
        for element in result.elements:
            require(not element.elements and element.compexpr is None
                    and element.where is None and not element.orderby,
                    "shape modifiers")
            require(element.operation.op.value == "ASSIGN"
                    and element.origin.value == "EXPLICIT", "shape operation")
            shape.append({
                "kind": "field", "name": field_name(element.expr, False),
                "operation": "assign", "origin": "explicit",
            })
        mapped = {
            "kind": "select", "typeName": type_name, "shape": shape,
            "fields": [e["name"] for e in shape],
        }
        if node.where is not None:
            where = node.where
            require(isinstance(where, qlast.BinOp) and where.op == "=",
                    "FILTER operator")
            value = expression(where.right)
            require(value["kind"] == "literal", "FILTER value")
            mapped["filter"] = {
                "kind": "predicate",
                "target": {"kind": "field", "field": field_name(where.left, True)},
                "op": "=", "value": value["value"],
            }
    else:
        require(node.where is None, "expression SELECT with FILTER")
        mapped = {"kind": "select_expr", "expr": expression(result)}
    mapped["pos"] = {"line": 1, "column": node.span.start + 1}
    return mapped


def main():
    verdicts = []
    for source in json.load(sys.stdin):
        try:
            commands = parser.parse_block(source)
        except errors.EdgeQLSyntaxError as exc:
            verdicts.append({"accepted": False, "error": str(exc)})
            continue
        try:
            require(len(commands) == 1, "expected one command")
            verdicts.append({"accepted": True, "ast": select(commands[0])})
        except Unmapped as exc:
            verdicts.append({"accepted": True, "unmapped": str(exc)})
    json.dump(verdicts, sys.stdout)


if __name__ == "__main__":
    main()
