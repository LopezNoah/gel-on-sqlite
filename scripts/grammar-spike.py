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


def introspect_expression(node, source):
    if isinstance(node.type, qlast.TypeOf):
        return {
            "kind": "introspect_typeof",
            "expr": expression(node.type.expr, source),
            "typeofForm": True,
        }
    if isinstance(node.type, qlast.TypeName):
        require(isinstance(node.type.maintype, qlast.ObjectRef),
                "INTROSPECT named type")
        maintype = node.type.maintype
        name = f"{maintype.module}::{maintype.name}" if maintype.module else maintype.name
        return {
            "kind": "introspect_typeof",
            "expr": {"kind": "binding_ref", "name": name},
            "typeofForm": False,
        }
    raise Unmapped(f"INTROSPECT operand {type(node.type).__name__}")


def expression(node, source=""):
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
    if isinstance(node, qlast.Set):
        values = []
        for element in node.elements:
            require(isinstance(element, qlast.Constant), "typed set element")
            value = expression(element, source)
            require(value["kind"] == "literal", "non-literal set element")
            values.append(value["value"])
        return {"kind": "set_literal", "values": values}
    if isinstance(node, qlast.Introspect):
        return introspect_expression(node, source)
    if isinstance(node, qlast.Path):
        require(node.steps and isinstance(node.steps[0], qlast.Introspect),
                "path expression")
        mapped = introspect_expression(node.steps[0], source)
        for step in node.steps[1:]:
            require(isinstance(step, qlast.Ptr)
                    and step.direction.name == "Outbound", "INTROSPECT path step")
            mapped = {
                "kind": "field_access", "expr": mapped,
                "field": step.name, "optional": False,
            }
        return mapped
    if isinstance(node, qlast.BinOp):
        require(node.op in ("+", "-", "*", "/"), f"operator {node.op}")
        return {
            "kind": "math", "op": node.op,
            "left": expression(node.left, source), "right": expression(node.right, source),
        }
    if isinstance(node, qlast.FunctionCall):
        require(isinstance(node.func, str), "qualified function name")
        args = [function_arg(arg, source) for arg in node.args]
        args.extend({
            "kind": "named_arg", "name": name, "arg": function_arg(arg, source),
        } for name, arg in node.kwargs.items())
        return {"kind": "function_call", "call": {"name": node.func, "args": args}}
    if isinstance(node, qlast.QueryParameter):
        return {"kind": "parameter", "name": node.name}
    if isinstance(node, qlast.TypeCast):
        require(node.cardinality_mod is None, "cast cardinality modifier")
        cast_type = type_expr(node.type)
        require(cast_type["kind"] == "type_name", "compound cast type")
        return {
            "kind": "cast", "castType": cast_type["name"],
            "expr": expression(node.expr, source),
        }
    if isinstance(node, qlast.InsertQuery):
        return {"kind": "mutation_expr", "statement": insert_statement(node, source)}
    raise Unmapped(f"expression {type(node).__name__}")


def function_arg(node, source=""):
    return {"kind": "expr", "expr": expression(node, source)}


def bare_name(node):
    require(isinstance(node, qlast.Path) and not node.partial and node.steps
            and isinstance(node.steps[0], qlast.ObjectRef),
            "expected unqualified type name")
    require(node.steps[0].module is None, "qualified type name")
    return node.steps[0].name


def type_expr(node):
    if isinstance(node, qlast.TypeName):
        require(node.maintype.module is None, "qualified type expression")
        return {"kind": "type_name", "name": node.maintype.name}
    if isinstance(node, qlast.TypeOp):
        return {
            "kind": "type_intersection" if node.op.value == "&" else "type_union",
            "left": type_expr(node.left),
            "right": type_expr(node.right),
        }
    raise Unmapped(f"type expression {type(node).__name__}")


def simple_type_name(node):
    return node["name"] if node["kind"] == "type_name" else ""


def field_name(node, partial):
    require(isinstance(node, qlast.Path) and node.partial == partial
            and len(node.steps) == 1 and isinstance(node.steps[0], qlast.Ptr),
            "expected single field path")
    require(node.steps[0].direction.name == "Outbound", "inbound field")
    return node.steps[0].name


def shape_element(element):
    require(not element.elements and element.compexpr is None
            and element.where is None and not element.orderby,
            "shape modifiers")
    require(element.operation.op.value == "ASSIGN"
            and element.origin.value == "EXPLICIT", "shape operation")
    steps = element.expr.steps if isinstance(element.expr, qlast.Path) else []
    if len(steps) == 1 and isinstance(steps[0], qlast.Ptr):
        require(steps[0].direction.name == "Outbound", "inbound field")
        return {
            "kind": "field", "name": steps[0].name,
            "operation": "assign", "origin": "explicit",
        }
    if (len(steps) == 2 and isinstance(steps[0], qlast.TypeIntersection)
            and isinstance(steps[1], qlast.Ptr)):
        require(steps[1].direction.name == "Outbound", "inbound polymorphic field")
        intersection = type_expr(steps[0].type)
        return {
            "kind": "computed", "name": steps[1].name,
            "expr": {
                "kind": "polymorphic_field_ref",
                "sourceType": simple_type_name(intersection),
                "sourceTypeExpr": intersection,
                "field": steps[1].name,
            },
            "operation": "assign", "origin": "explicit",
        }
    raise Unmapped("shape element path")


def source_position(node, source):
    prefix = source[:node.span.start]
    return {
        "line": prefix.count("\n") + 1,
        "column": len(prefix.rsplit("\n", 1)[-1]) + 1,
    }


def insert_value(expr):
    if expr["kind"] == "literal":
        return expr["value"]
    if expr["kind"] == "cast" and expr["expr"]["kind"] == "literal":
        return str(expr["expr"]["value"])
    return {"kind": "expr", "expr": expr}


def insert_conflict_else(node):
    require(isinstance(node, qlast.Path) and not node.partial
            and len(node.steps) == 1 and isinstance(node.steps[0], qlast.ObjectRef),
            "INSERT conflict ELSE expression")
    require(node.steps[0].module is None, "qualified conflict ELSE type")
    return {
        "kind": "select", "typeName": node.steps[0].name,
        "shape": [{"kind": "field", "name": "id", "operation": "assign", "origin": "default"}],
        "clauses": {},
    }


def insert_statement(node, source):
    require(isinstance(node, qlast.InsertQuery), f"statement {type(node).__name__}")
    require(isinstance(node.subject, qlast.ObjectRef), "INSERT subject")
    require(node.subject.module is None, "qualified INSERT subject")
    values = {}
    for element in node.shape:
        require(element.compexpr is not None, "INSERT assignment expression")
        require(not element.elements and element.where is None and not element.orderby,
                "INSERT shape modifiers")
        require(element.operation.op.value == "ASSIGN"
                and element.origin.value == "EXPLICIT", "INSERT operation")
        field = field_name(element.expr, False)
        values[field] = insert_value(expression(element.compexpr, source))

    mapped = {
        "kind": "insert", "typeName": node.subject.name, "values": values,
        "pos": source_position(node, source),
    }
    if node.unless_conflict is not None:
        target, otherwise = node.unless_conflict
        conflict = {}
        if target is not None:
            conflict["onField"] = field_name(target, True)
        if otherwise is not None:
            conflict["else"] = insert_conflict_else(otherwise)
        mapped["conflict"] = conflict
    return mapped


def select(node, source):
    require(isinstance(node, qlast.SelectQuery), f"statement {type(node).__name__}")
    require(not node.aliases and node.result_alias is None and not node.orderby
            and node.offset is None and node.limit is None, "SELECT clauses")
    # The fixture uses ASCII, so Gel's byte offset is also a character offset.
    result = node.result
    if isinstance(result, qlast.Shape):
        type_name = bare_name(result.expr)
        shape = [shape_element(element) for element in result.elements]
        root_filters = [
            type_expr(step.type) for step in result.expr.steps[1:]
            if isinstance(step, qlast.TypeIntersection)
        ]
        require(len(root_filters) == len(result.expr.steps) - 1,
                "non-type step after object root")
        mapped = {
            "kind": "select", "typeName": type_name, "shape": shape,
            "fields": [e["name"] for e in shape if e["kind"] == "field"],
        }
        if root_filters:
            mapped["typeFilterExprs"] = root_filters
        if node.where is not None:
            where = node.where
            require(isinstance(where, qlast.BinOp) and where.op == "=",
                    "FILTER operator")
            value = expression(where.right, source)
            require(value["kind"] == "literal", "FILTER value")
            mapped["filter"] = {
                "kind": "predicate",
                "target": {"kind": "field", "field": field_name(where.left, True)},
                "op": "=", "value": value["value"],
            }
    else:
        require(node.where is None, "expression SELECT with FILTER")
        mapped = {"kind": "select_expr", "expr": expression(result, source)}
    mapped["pos"] = source_position(node, source)
    return mapped


def statement(node, source):
    if isinstance(node, qlast.SelectQuery):
        return select(node, source)
    if isinstance(node, qlast.InsertQuery):
        return insert_statement(node, source)
    raise Unmapped(f"statement {type(node).__name__}")


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
            verdicts.append({"accepted": True, "ast": statement(commands[0], source)})
        except Unmapped as exc:
            verdicts.append({"accepted": True, "unmapped": str(exc)})
    json.dump(verdicts, sys.stdout)


if __name__ == "__main__":
    main()
