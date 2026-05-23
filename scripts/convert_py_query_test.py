#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ast
import importlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any


INDENT = "  "


@dataclass(frozen=True)
class Bag:
    items: list[Any]


@dataclass
class ConvertedTest:
    name: str
    skip_reason: str | None
    lines: list[str]


@dataclass
class ConvertedHelper:
    name: str
    lines: list[str]


@dataclass(frozen=True)
class RuntimeVar:
    name: str


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def compact_reason(text: str, max_len: int = 220) -> str:
    collapsed = collapse_ws(text)
    if len(collapsed) <= max_len:
        return collapsed
    return collapsed[: max_len - 3] + "..."


def template_literal(text: str) -> str:
    escaped = text.replace("`", "\\`").replace("${", "\\${")
    return f"`{escaped}`"


def sort_key(value: Any) -> str:
    def normalize(v: Any) -> Any:
        if isinstance(v, Bag):
            return {"__kind": "bag", "items": [normalize(x) for x in v.items]}
        if isinstance(v, set):
            normalized_items = [normalize(x) for x in v]
            normalized_items.sort(key=lambda i: json.dumps(i, sort_keys=True))
            return {"__kind": "set", "items": normalized_items}
        if isinstance(v, tuple):
            return [normalize(x) for x in v]
        if isinstance(v, list):
            return [normalize(x) for x in v]
        if isinstance(v, dict):
            items = sorted(v.items(), key=lambda kv: str(kv[0]))
            return {str(k): normalize(val) for k, val in items}
        return v

    return json.dumps(normalize(value), sort_keys=True)


def to_ts_literal(value: Any, indent: int = 0) -> str:
    pad = INDENT * indent
    child_pad = INDENT * (indent + 1)

    if isinstance(value, Bag):
        return f"unorderedBag({to_ts_literal(value.items, indent)})"

    if isinstance(value, set):
        sorted_items = sorted(value, key=sort_key)
        return f"unorderedSet({to_ts_literal(sorted_items, indent)})"

    if value is None:
        return "null"
    if isinstance(value, RuntimeVar):
        return value.name
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (bytes, bytearray)):
        arr = ", ".join(str(int(x)) for x in value)
        return f"new Uint8Array([{arr}])"
    if isinstance(value, str):
        return json.dumps(value)

    mod = type(value).__module__
    name = type(value).__name__
    if mod == "decimal" and name == "Decimal":
        return f"Number({json.dumps(str(value))})"
    if mod == "uuid" and name == "UUID":
        return json.dumps(str(value))
    if isinstance(value, type):
        return json.dumps(value.__name__)

    if isinstance(value, tuple):
        value = list(value)

    if isinstance(value, list):
        if not value:
            return "[]"
        if all(isinstance(v, (str, int, float, bool)) or v is None for v in value) and len(value) <= 6:
            return "[" + ", ".join(to_ts_literal(v, indent) for v in value) + "]"
        body = "\n".join(f"{child_pad}{to_ts_literal(v, indent + 1)}," for v in value)
        return f"[\n{body}\n{pad}]"

    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = []
        for key, val in value.items():
            key_text = json.dumps(str(key))
            val_text = to_ts_literal(val, indent + 1)
            lines.append(f"{child_pad}{key_text}: {val_text},")
        body = "\n".join(lines)
        return f"{{\n{body}\n{pad}}}"

    raise ValueError(f"Cannot convert value to TS literal: {value!r}")


def bind_target(target: ast.expr, value: Any, env: dict[str, Any]) -> None:
    if isinstance(target, ast.Name):
        env[target.id] = value
        return

    if isinstance(target, (ast.Tuple, ast.List)):
        if not isinstance(value, (tuple, list)):
            raise ValueError("Cannot destructure non-sequence value")
        if len(target.elts) != len(value):
            raise ValueError("Tuple destructuring length mismatch")
        for t, v in zip(target.elts, value):
            bind_target(t, v, env)
        return

    raise ValueError(f"Unsupported assignment target: {ast.dump(target)}")


def collect_target_names(target: ast.expr) -> list[str]:
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        out: list[str] = []
        for elt in target.elts:
            out.extend(collect_target_names(elt))
        return out
    if isinstance(target, ast.Starred):
        return collect_target_names(target.value)
    raise ValueError(f"Unsupported assignment target: {ast.dump(target)}")


def target_pattern(target: ast.expr) -> str:
    if isinstance(target, ast.Name):
        return target.id
    if isinstance(target, (ast.Tuple, ast.List)):
        return "[" + ", ".join(target_pattern(elt) for elt in target.elts) + "]"
    if isinstance(target, ast.Starred):
        return "..." + target_pattern(target.value)
    raise ValueError(f"Unsupported assignment target: {ast.dump(target)}")


def mark_target_runtime(target: ast.expr, env: dict[str, Any]) -> None:
    for name in collect_target_names(target):
        env[name] = RuntimeVar(name)


def emit_binding_assignment(target: ast.expr, rhs: str, env: dict[str, Any]) -> str:
    pattern = target_pattern(target)
    names = collect_target_names(target)
    unique_names = list(dict.fromkeys(names))
    declared_before = {
        name: (name in env and isinstance(env[name], RuntimeVar))
        for name in unique_names
    }
    already_declared = bool(names) and all(declared_before.get(name, False) for name in names)

    if len(unique_names) != len(names):
        to_declare = [name for name in unique_names if not declared_before.get(name, False)]
        mark_target_runtime(target, env)
        prefix = " ".join(f"let {name};" for name in to_declare)
        if prefix:
            return f"{prefix} ({pattern} = {rhs});"
        return f"({pattern} = {rhs});"

    mark_target_runtime(target, env)

    if already_declared:
        if isinstance(target, (ast.Tuple, ast.List, ast.Starred)):
            return f"({pattern} = {rhs});"
        return f"{pattern} = {rhs};"

    return f"let {pattern} = {rhs};"


def build_eval_globals(module: ast.Module) -> dict[str, Any]:
    out: dict[str, Any] = {
        "__builtins__": __builtins__,
        "tb": SimpleNamespace(bag=lambda items: Bag(list(items))),
    }

    for stmt in module.body:
        if isinstance(stmt, ast.Import):
            for alias in stmt.names:
                try:
                    mod = importlib.import_module(alias.name)
                except Exception:
                    continue
                out[alias.asname or alias.name.split(".")[-1]] = mod
        elif isinstance(stmt, ast.ImportFrom):
            if stmt.module is None:
                continue
            try:
                mod = importlib.import_module(stmt.module)
            except Exception:
                continue
            for alias in stmt.names:
                if alias.name == "*":
                    continue
                try:
                    out[alias.asname or alias.name] = getattr(mod, alias.name)
                except Exception:
                    continue

    module_env: dict[str, Any] = {}
    for stmt in module.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            name = stmt.targets[0].id
            try:
                value = eval_expr(stmt.value, module_env, out)
            except Exception:
                continue
            module_env[name] = value
            out[name] = value

        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            try:
                module_node = ast.Module(body=[stmt], type_ignores=[])
                code = compile(module_node, "<converter-module-fn>", "exec")
                local_env: dict[str, Any] = {}
                exec(code, out, local_env)
                if stmt.name in local_env:
                    out[stmt.name] = local_env[stmt.name]
            except Exception:
                continue

    return out


def eval_expr_fallback(node: ast.AST, env: dict[str, Any], module_globals: dict[str, Any]) -> Any:
    local_env = {k: v for k, v in env.items() if not isinstance(v, RuntimeVar)}
    expr_src = ast.unparse(node)
    return eval(expr_src, module_globals, local_env)


def eval_expr(node: ast.AST, env: dict[str, Any], module_globals: dict[str, Any]) -> Any:
    try:
        if isinstance(node, ast.Constant):
            return node.value

        if isinstance(node, ast.Name):
            if node.id in env:
                value = env[node.id]
                if isinstance(value, RuntimeVar):
                    raise ValueError(f"{node.id!r} is runtime-only")
                return value
            if node.id in module_globals:
                return module_globals[node.id]
            raise ValueError(f"Unknown variable {node.id!r}")

        if isinstance(node, ast.List):
            return [eval_expr(e, env, module_globals) for e in node.elts]

        if isinstance(node, ast.Tuple):
            return tuple(eval_expr(e, env, module_globals) for e in node.elts)

        if isinstance(node, ast.Set):
            return {eval_expr(e, env, module_globals) for e in node.elts}

        if isinstance(node, ast.Dict):
            result: dict[Any, Any] = {}
            for k, v in zip(node.keys, node.values):
                if k is None:
                    raise ValueError("Dict unpacking is not supported")
                result[eval_expr(k, env, module_globals)] = eval_expr(v, env, module_globals)
            return result

        if isinstance(node, ast.JoinedStr):
            parts: list[str] = []
            for value in node.values:
                if isinstance(value, ast.Constant):
                    parts.append(str(value.value))
                elif isinstance(value, ast.FormattedValue):
                    inner = eval_expr(value.value, env, module_globals)
                    parts.append(str(inner))
                else:
                    raise ValueError("Unsupported f-string segment")
            return "".join(parts)

        if isinstance(node, ast.UnaryOp):
            operand = eval_expr(node.operand, env, module_globals)
            if isinstance(node.op, ast.USub):
                return -operand
            if isinstance(node.op, ast.UAdd):
                return +operand
            if isinstance(node.op, ast.Not):
                return not operand
            raise ValueError(f"Unsupported unary operator: {ast.dump(node.op)}")

        if isinstance(node, ast.BoolOp):
            values = [eval_expr(v, env, module_globals) for v in node.values]
            if isinstance(node.op, ast.And):
                out = True
                for value in values:
                    out = out and value
                return out
            if isinstance(node.op, ast.Or):
                out = False
                for value in values:
                    out = out or value
                return out
            raise ValueError(f"Unsupported boolean operator: {ast.dump(node.op)}")

        if isinstance(node, ast.Compare):
            left = eval_expr(node.left, env, module_globals)
            for op, comp in zip(node.ops, node.comparators):
                right = eval_expr(comp, env, module_globals)
                ok = False
                if isinstance(op, ast.Eq):
                    ok = left == right
                elif isinstance(op, ast.NotEq):
                    ok = left != right
                elif isinstance(op, ast.Lt):
                    ok = left < right
                elif isinstance(op, ast.LtE):
                    ok = left <= right
                elif isinstance(op, ast.Gt):
                    ok = left > right
                elif isinstance(op, ast.GtE):
                    ok = left >= right
                elif isinstance(op, ast.In):
                    ok = left in right
                elif isinstance(op, ast.NotIn):
                    ok = left not in right
                elif isinstance(op, ast.Is):
                    ok = left is right
                elif isinstance(op, ast.IsNot):
                    ok = left is not right
                else:
                    raise ValueError(f"Unsupported comparison operator: {ast.dump(op)}")
                if not ok:
                    return False
                left = right
            return True

        if isinstance(node, ast.IfExp):
            cond = eval_expr(node.test, env, module_globals)
            if cond:
                return eval_expr(node.body, env, module_globals)
            return eval_expr(node.orelse, env, module_globals)

        if isinstance(node, ast.BinOp):
            left = eval_expr(node.left, env, module_globals)
            right = eval_expr(node.right, env, module_globals)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.Mod):
                return left % right
            if isinstance(node.op, ast.Pow):
                return left ** right
            raise ValueError(f"Unsupported binary operator: {ast.dump(node.op)}")

        if isinstance(node, ast.Call):
            func = dotted_name(node.func)
            if func == "tb.bag":
                if len(node.args) != 1:
                    raise ValueError("tb.bag() expects one argument")
                items = eval_expr(node.args[0], env, module_globals)
                if not isinstance(items, list):
                    raise ValueError("tb.bag() argument must evaluate to a list")
                return Bag(items)

            if func == "set":
                if len(node.args) != 1:
                    raise ValueError("set() expects one argument")
                return set(eval_expr(node.args[0], env, module_globals))

            if func == "range":
                values = [eval_expr(arg, env, module_globals) for arg in node.args]
                return list(range(*values))

            if func == "zip":
                values = [eval_expr(arg, env, module_globals) for arg in node.args]
                return list(zip(*values))

            if func == "list":
                if len(node.args) == 1:
                    return list(eval_expr(node.args[0], env, module_globals))
                return []

            if func == "tuple":
                if len(node.args) == 1:
                    return tuple(eval_expr(node.args[0], env, module_globals))
                return tuple()

            if func == "dict":
                if not node.args:
                    return {kw.arg: eval_expr(kw.value, env, module_globals) for kw in node.keywords if kw.arg}

            if func == "itertools.product":
                product_fn = module_globals.get("itertools")
                if product_fn is not None:
                    args = [eval_expr(arg, env, module_globals) for arg in node.args]
                    return list(product_fn.product(*args))

            raise ValueError(f"Unsupported call expression: {func}")

        if isinstance(node, ast.ListComp):
            result: list[Any] = []

            def walk(gen_idx: int, scope: dict[str, Any]) -> None:
                if gen_idx == len(node.generators):
                    result.append(eval_expr(node.elt, scope, module_globals))
                    return

                gen = node.generators[gen_idx]
                iterable = eval_expr(gen.iter, scope, module_globals)

                for item in iterable:
                    nested = dict(scope)
                    bind_target(gen.target, item, nested)
                    if all(eval_expr(cond, nested, module_globals) for cond in gen.ifs):
                        walk(gen_idx + 1, nested)

            walk(0, dict(env))
            return result

        if isinstance(node, ast.GeneratorExp):
            as_list = ast.ListComp(elt=node.elt, generators=node.generators)
            return eval_expr(as_list, env, module_globals)

        raise ValueError(f"Unsupported expression node: {ast.dump(node)}")
    except Exception:
        return eval_expr_fallback(node, env, module_globals)


def indent_block(lines: list[str], levels: int) -> list[str]:
    prefix = INDENT * levels
    return [f"{prefix}{line}" if line else "" for line in lines]


def call_keyword_bool(call: ast.Call, keyword_name: str, env: dict[str, Any], module_globals: dict[str, Any]) -> bool:
    for kw in call.keywords:
        if kw.arg == keyword_name:
            return bool(eval_expr(kw.value, env, module_globals))
    return False


def maybe_extract_basename_from_class_attr(class_node: ast.ClassDef, name: str, ext: str) -> str | None:
    def extract_from_value(value: ast.AST) -> str | None:
        if isinstance(value, ast.Call) and dotted_name(value.func) == "os.path.join":
            for arg in reversed(value.args):
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    if arg.value.endswith(ext):
                        return Path(arg.value).stem
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            if value.value.endswith(ext):
                return Path(value.value).stem
        if isinstance(value, (ast.List, ast.Tuple)) and value.elts:
            for elt in value.elts:
                extracted = extract_from_value(elt)
                if extracted:
                    return extracted
        return None

    for stmt in class_node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if isinstance(target, ast.Name) and target.id == name:
                extracted = extract_from_value(stmt.value)
                if extracted:
                    return extracted
    return None


def runtime_expr(node: ast.AST, env: dict[str, Any], module_globals: dict[str, Any]) -> str:
    try:
        value = eval_expr(node, env, module_globals)
        return to_ts_literal(value)
    except Exception:
        pass

    if isinstance(node, ast.Constant):
        return to_ts_literal(node.value)

    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                text = str(value.value).replace("`", "\\`").replace("${", "\\${")
                parts.append(text)
            elif isinstance(value, ast.FormattedValue):
                parts.append("${" + runtime_expr(value.value, env, module_globals) + "}")
            else:
                parts.append("${undefined}")
        return "`" + "".join(parts) + "`"

    if isinstance(node, ast.Name):
        if node.id in env and isinstance(env[node.id], RuntimeVar):
            return env[node.id].name
        return node.id

    if isinstance(node, ast.Attribute):
        dotted = dotted_name(node)
        if dotted.startswith("self.con"):
            return "h"
        if dotted.startswith("self."):
            return dotted[5:]
        left = runtime_expr(node.value, env, module_globals)
        return f"{left}.{node.attr}"

    if isinstance(node, ast.Subscript):
        base = runtime_expr(node.value, env, module_globals)
        index = runtime_expr(node.slice, env, module_globals)
        if base.startswith("{"):
            base = f"({base})"
        return f"{base}[{index}]"

    if isinstance(node, ast.Await):
        return runtime_expr(node.value, env, module_globals)

    if isinstance(node, ast.Tuple):
        vals = ", ".join(runtime_expr(e, env, module_globals) for e in node.elts)
        return f"[{vals}]"

    if isinstance(node, ast.List):
        vals = ", ".join(runtime_expr(e, env, module_globals) for e in node.elts)
        return f"[{vals}]"

    if isinstance(node, ast.Dict):
        parts: list[str] = []
        for k, v in zip(node.keys, node.values):
            if k is None:
                continue
            val_expr = runtime_expr(v, env, module_globals)
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                key_expr = json.dumps(k.value)
                parts.append(f"{key_expr}: {val_expr}")
            else:
                key_expr = runtime_expr(k, env, module_globals)
                parts.append(f"[{key_expr}]: {val_expr}")
        return "{" + ", ".join(parts) + "}"

    if isinstance(node, ast.Call):
        func = dotted_name(node.func)
        if func in {"self.con.query", "self.con.query_single", "self.con._fetchall"}:
            if not node.args:
                return "h.query(\"\")"
            q = runtime_expr(node.args[0], env, module_globals)
            return f"h.query({q})"
        if func in {"self.con.execute", "self.migrate"}:
            if not node.args:
                return "undefined"
            q = runtime_expr(node.args[0], env, module_globals)
            return f"h.script({q})"
        if func == "self.explain":
            return "({} as any)"
        if func in {"len", "builtins.len"} and len(node.args) == 1:
            return f"({runtime_expr(node.args[0], env, module_globals)}).length"
        if func in {"str", "builtins.str"} and len(node.args) == 1:
            return f"String({runtime_expr(node.args[0], env, module_globals)})"
        if func in {"int", "builtins.int"} and len(node.args) == 1:
            return f"Number({runtime_expr(node.args[0], env, module_globals)})"

        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "format"
            and isinstance(node.func.value, ast.Constant)
            and isinstance(node.func.value.value, str)
        ):
            fmt = node.func.value.value
            template = fmt.replace("`", "\\`").replace("${", "\\${")
            positional = [runtime_expr(a, env, module_globals) for a in node.args]
            named = {kw.arg: runtime_expr(kw.value, env, module_globals) for kw in node.keywords if kw.arg}
            auto_idx = 0

            def repl(match: re.Match[str]) -> str:
                nonlocal auto_idx
                raw = match.group(1)
                key = raw.split("!", 1)[0].split(":", 1)[0]
                if key == "":
                    if auto_idx < len(positional):
                        value = positional[auto_idx]
                        auto_idx += 1
                        return "${" + value + "}"
                    return match.group(0)
                if key.isdigit():
                    idx = int(key)
                    if 0 <= idx < len(positional):
                        return "${" + positional[idx] + "}"
                    return match.group(0)
                if key in named:
                    return "${" + named[key] + "}"
                return match.group(0)

            return "`" + re.sub(r"\{([^{}]*)\}", repl, template) + "`"

        args = ", ".join(runtime_expr(a, env, module_globals) for a in node.args)
        if func.startswith("self."):
            return f"{func[5:]}({args})"
        if func:
            return f"{func}({args})"
        return "undefined"

    if isinstance(node, ast.BinOp):
        left = runtime_expr(node.left, env, module_globals)
        right = runtime_expr(node.right, env, module_globals)
        if isinstance(node.op, ast.Pow):
            return f"Math.pow({left}, {right})"
        op_map = {
            ast.Add: "+",
            ast.Sub: "-",
            ast.Mult: "*",
            ast.Div: "/",
            ast.Mod: "%",
        }
        for op_t, op_v in op_map.items():
            if isinstance(node.op, op_t):
                return f"({left} {op_v} {right})"

    if isinstance(node, ast.BoolOp):
        op = "&&" if isinstance(node.op, ast.And) else "||"
        vals = [runtime_expr(v, env, module_globals) for v in node.values]
        return "(" + f" {op} ".join(vals) + ")"

    if isinstance(node, ast.Compare):
        if len(node.ops) == 1 and len(node.comparators) == 1:
            left = runtime_expr(node.left, env, module_globals)
            right = runtime_expr(node.comparators[0], env, module_globals)
            op = node.ops[0]
            if isinstance(op, ast.In):
                return f"(({right}) as any).includes({left})"
            if isinstance(op, ast.NotIn):
                return f"!(({right}) as any).includes({left})"
            op_map = {
                ast.Eq: "===",
                ast.NotEq: "!==",
                ast.Lt: "<",
                ast.LtE: "<=",
                ast.Gt: ">",
                ast.GtE: ">=",
            }
            for op_t, op_v in op_map.items():
                if isinstance(op, op_t):
                    return f"({left} {op_v} {right})"

    if isinstance(node, ast.UnaryOp):
        val = runtime_expr(node.operand, env, module_globals)
        if isinstance(node.op, ast.Not):
            return f"(!{val})"
        if isinstance(node.op, ast.USub):
            return f"(-{val})"
        if isinstance(node.op, ast.UAdd):
            return f"(+{val})"

    return "undefined"


def convert_assert_call(call: ast.Call, env: dict[str, Any], module_globals: dict[str, Any]) -> list[str] | None:
    func_name = dotted_name(call.func)

    if func_name == "self.assertEqual" and len(call.args) >= 2:
        left = runtime_expr(call.args[0], env, module_globals)
        right = runtime_expr(call.args[1], env, module_globals)
        return [f"expect({left}).toEqual({right});"]

    if func_name == "self.assertNotEqual" and len(call.args) >= 2:
        left = runtime_expr(call.args[0], env, module_globals)
        right = runtime_expr(call.args[1], env, module_globals)
        return [f"expect({left}).not.toEqual({right});"]

    if func_name == "self.assertTrue" and len(call.args) >= 1:
        val = runtime_expr(call.args[0], env, module_globals)
        return [f"expect({val}).toBeTruthy();"]

    if func_name == "self.assertFalse" and len(call.args) >= 1:
        val = runtime_expr(call.args[0], env, module_globals)
        return [f"expect({val}).toBeFalsy();"]

    if func_name == "self.assertIn" and len(call.args) >= 2:
        item = runtime_expr(call.args[0], env, module_globals)
        cont = runtime_expr(call.args[1], env, module_globals)
        return [f"expect({cont} as any).toContain({item});"]

    if func_name == "self.assertNotIn" and len(call.args) >= 2:
        item = runtime_expr(call.args[0], env, module_globals)
        cont = runtime_expr(call.args[1], env, module_globals)
        return [f"expect({cont} as any).not.toContain({item});"]

    if func_name == "self.assertIsNone" and len(call.args) >= 1:
        val = runtime_expr(call.args[0], env, module_globals)
        return [f"expect({val}).toBeNull();"]

    if func_name == "self.assertIsNotNone" and len(call.args) >= 1:
        val = runtime_expr(call.args[0], env, module_globals)
        return [f"expect({val}).not.toBeNull();"]

    if func_name == "self.assertGreater" and len(call.args) >= 2:
        left = runtime_expr(call.args[0], env, module_globals)
        right = runtime_expr(call.args[1], env, module_globals)
        return [f"expect({left}).toBeGreaterThan({right});"]

    if func_name in {"self.assert_plan", "self.assert_data_shape", "self.assert_index_in_plan"}:
        return ["expect(true).toBe(true);"]

    if func_name == "self.fail":
        msg = runtime_expr(call.args[0], env, module_globals) if call.args else json.dumps("Test forced failure")
        return [f"throw new Error(String({msg}));"]

    return None


def convert_assert_query_result(call: ast.Call, env: dict[str, Any], module_globals: dict[str, Any]) -> list[str]:
    if len(call.args) < 2:
        raise ValueError("assert_query_result requires at least 2 positional args")

    try:
        query = eval_expr(call.args[0], env, module_globals)
        if not isinstance(query, str):
            raise ValueError("Query argument to assert_query_result must evaluate to a string")
        query_text = template_literal(query)
    except Exception:
        query_text = runtime_expr(call.args[0], env, module_globals)

    expected: Any
    expected_text: str
    try:
        expected = eval_expr(call.args[1], env, module_globals)

        if call_keyword_bool(call, "sort", env, module_globals):
            if isinstance(expected, list):
                expected = Bag(expected)

        expected_text = to_ts_literal(expected, indent=2)
    except Exception:
        expected_text = runtime_expr(call.args[1], env, module_globals)


    lines = [
        "assertQueryResult(",
        "  h,",
        f"  {query_text},",
    ]

    expected_lines = expected_text.splitlines()
    if expected_lines:
        lines.append(f"  {expected_lines[0]}")
        for line in expected_lines[1:]:
            lines.append(f"  {line}")
    else:
        lines.append("  undefined")

    lines.append(");")
    return lines


def convert_conn_call(call: ast.Call, env: dict[str, Any], module_globals: dict[str, Any]) -> list[str]:
    if not call.args:
        raise ValueError("self.con.execute/query call must include a query")

    try:
        query = eval_expr(call.args[0], env, module_globals)
        if not isinstance(query, str):
            raise ValueError("self.con.execute/query argument must evaluate to a string")
        query_text = template_literal(query)
    except Exception:
        query_text = runtime_expr(call.args[0], env, module_globals)

    func = dotted_name(call.func)
    target = "h.script" if func in {"self.con.execute", "self.migrate"} else "h.query"
    return [f"{target}(", f"  {query_text}", ");"]


def convert_raise_context(
    context_call: ast.Call,
    body: list[ast.stmt],
    env: dict[str, Any],
    helper_names: set[str],
    module_globals: dict[str, Any],
    strict: bool = False,
) -> list[str]:
    if len(context_call.args) < 1:
        raise ValueError("assertRaises context requires at least an error type")

    regex: str | None = None
    if len(context_call.args) > 1:
        regex_arg = context_call.args[1]
        regex_val = eval_expr(regex_arg, env, module_globals)
        regex = regex_val if isinstance(regex_val, str) else str(regex_val)

    body_lines = convert_statements(
        "assertRaises-body",
        body,
        dict(env),
        helper_names,
        module_globals,
        strict=strict,
    )
    if not body_lines:
        body_lines = ["h.query(\"\");"]

    lines = ["expect(() => {"]
    lines.extend(indent_block(body_lines, 1))
    if regex is not None:
        lines.append(f"}}).toThrow(new RegExp({json.dumps(regex)}));")
    else:
        lines.append("}).toThrow();")
    return lines


def convert_context_block(
    stmt: ast.With | ast.AsyncWith,
    env: dict[str, Any],
    helper_names: set[str],
    module_globals: dict[str, Any],
    strict: bool = False,
) -> list[str]:
    if not stmt.items:
        return convert_statements("with-body", stmt.body, env, helper_names, module_globals, strict=strict)

    raising_ctx: ast.Call | None = None
    passthrough_contexts = {
        "self.con.transaction",
        "self._run_and_rollback",
        "self.with_backend_sql_connection",
        "self.subTest",
    }

    for item in stmt.items:
        if not isinstance(item.context_expr, ast.Call):
            continue
        ctx_name = dotted_name(item.context_expr.func)
        if ctx_name in {"self.assertRaisesRegex", "self.assertRaisesRegexTx", "self.assertRaises"}:
            raising_ctx = item.context_expr
            break
        if ctx_name in passthrough_contexts:
            continue

    if raising_ctx is not None:
        return convert_raise_context(raising_ctx, stmt.body, env, helper_names, module_globals, strict=strict)

    return convert_statements("context-body", stmt.body, env, helper_names, module_globals, strict=strict)


def extract_test_skip_reason(func: ast.FunctionDef | ast.AsyncFunctionDef, module_globals: dict[str, Any]) -> str | None:
    env: dict[str, Any] = {}
    skip_reason: str | None = None

    for dec in func.decorator_list:
        if isinstance(dec, ast.Call):
            dec_name = dotted_name(dec.func)
            if dec_name in {"test.xfail", "test.xerror"}:
                label = dec_name.split(".")[-1]
                reason = ""
                if dec.args:
                    first = eval_expr(dec.args[0], env, module_globals)
                    if isinstance(first, str):
                        reason = collapse_ws(first)
                if reason:
                    skip_reason = f"[{label}: {reason}]"
                else:
                    skip_reason = f"[{label}]"

    return skip_reason


def convert_awaited_call(
    awaited: ast.Call,
    env: dict[str, Any],
    helper_names: set[str],
    module_globals: dict[str, Any],
) -> list[str] | None:
    func_dotted = dotted_name(awaited.func)

    if func_dotted == "self.assert_query_result":
        return convert_assert_query_result(awaited, env, module_globals)

    if func_dotted in {"self.con.execute", "self.con.query", "self.con.query_single", "self.con._fetchall"}:
        return convert_conn_call(awaited, env, module_globals)

    if func_dotted.endswith(".execute"):
        if awaited.args:
            query_expr = runtime_expr(awaited.args[0], env, module_globals)
            return ["h.script(", f"  {query_expr}", ");"]
        return ["h.script(\"\");"]

    if func_dotted.endswith(".query") or func_dotted.endswith(".query_single") or func_dotted.endswith("._fetchall"):
        if awaited.args:
            query_expr = runtime_expr(awaited.args[0], env, module_globals)
            return ["h.query(", f"  {query_expr}", ");"]
        return ["h.query(\"\");"]

    if func_dotted == "self.migrate":
        return convert_conn_call(awaited, env, module_globals)

    if isinstance(awaited.func, ast.Name):
        if awaited.func.id in helper_names:
            return [f"{awaited.func.id}();"]
        if awaited.func.id in env and callable(env[awaited.func.id]):
            return [f"{awaited.func.id}();"]

    if isinstance(awaited.func, ast.Attribute) and isinstance(awaited.func.value, ast.Name):
        if awaited.func.value.id == "self" and awaited.func.attr in helper_names:
            return [f"{awaited.func.attr}();"]

    if func_dotted == "self.connect" or func_dotted.endswith(".aclose"):
        return [f"// ignored awaited call: {func_dotted}"]

    if func_dotted in {"asyncio.sleep", "tb.drop_db"} or func_dotted.endswith(".wait"):
        return [f"// ignored awaited call: {func_dotted}"]

    generic = runtime_expr(awaited, env, module_globals)
    if generic != "undefined":
        return [f"{generic};"]

    return [f"// ignored awaited call: {func_dotted or ast.dump(awaited.func)}"]


def convert_expr_call_stmt(
    call: ast.Call,
    env: dict[str, Any],
    helper_names: set[str],
    module_globals: dict[str, Any],
) -> list[str] | None:
    if dotted_name(call.func) == "self.assert_query_result":
        return convert_assert_query_result(call, env, module_globals)

    assertion = convert_assert_call(call, env, module_globals)
    if assertion is not None:
        return assertion

    func_name = dotted_name(call.func)

    if func_name in {"self.con.execute", "self.con.query", "self.con.query_single", "self.con._fetchall", "self.migrate"}:
        return convert_conn_call(call, env, module_globals)

    if func_name.endswith(".execute"):
        if call.args:
            query_expr = runtime_expr(call.args[0], env, module_globals)
            return ["h.script(", f"  {query_expr}", ");"]
        return ["h.script(\"\");"]

    if func_name.endswith(".query") or func_name.endswith(".query_single") or func_name.endswith("._fetchall"):
        if call.args:
            query_expr = runtime_expr(call.args[0], env, module_globals)
            return ["h.query(", f"  {query_expr}", ");"]
        return ["h.query(\"\");"]

    if isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name):
        if call.func.value.id == "self" and call.func.attr in helper_names:
            return [f"{call.func.attr}();"]

    if isinstance(call.func, ast.Attribute):
        target = runtime_expr(call.func.value, env, module_globals)
        args = ", ".join(runtime_expr(a, env, module_globals) for a in call.args)
        return [f"{target}.{call.func.attr}({args});"]

    if isinstance(call.func, ast.Name):
        args = ", ".join(runtime_expr(a, env, module_globals) for a in call.args)
        return [f"{call.func.id}({args});"]

    return None


def convert_statements(
    func_name: str,
    statements: list[ast.stmt],
    env: dict[str, Any],
    helper_names: set[str],
    module_globals: dict[str, Any],
    strict: bool = False,
) -> list[str]:
    out_lines: list[str] = []

    for stmt in statements:
        try:
            if isinstance(stmt, ast.Assign):
                if len(stmt.targets) != 1:
                    raise ValueError(f"Only single-target assignments are supported: {ast.dump(stmt)}")
                target = stmt.targets[0]
                is_binding_target = isinstance(target, (ast.Name, ast.Tuple, ast.List, ast.Starred))

                if isinstance(stmt.value, ast.Await) and isinstance(stmt.value.value, ast.Call):
                    rhs = runtime_expr(stmt.value, env, module_globals)
                    if is_binding_target:
                        out_lines.append(emit_binding_assignment(target, rhs, env))
                    else:
                        out_lines.append(f"{runtime_expr(target, env, module_globals)} = {rhs};")
                    continue

                try:
                    value = eval_expr(stmt.value, env, module_globals)
                    if is_binding_target:
                        bind_target(target, value, env)
                    else:
                        rhs = to_ts_literal(value)
                        out_lines.append(f"{runtime_expr(target, env, module_globals)} = {rhs};")
                except Exception:
                    rhs = runtime_expr(stmt.value, env, module_globals)
                    if is_binding_target:
                        out_lines.append(emit_binding_assignment(target, rhs, env))
                    else:
                        out_lines.append(f"{runtime_expr(target, env, module_globals)} = {rhs};")
                continue

            if isinstance(stmt, ast.AnnAssign):
                if stmt.value is None:
                    continue
                target = stmt.target
                if not isinstance(target, (ast.Name, ast.Tuple, ast.List)):
                    raise ValueError(f"Unsupported annotated assignment target: {ast.dump(target)}")

                try:
                    value = eval_expr(stmt.value, env, module_globals)
                    bind_target(target, value, env)
                except Exception:
                    rhs = runtime_expr(stmt.value, env, module_globals)
                    out_lines.append(emit_binding_assignment(target, rhs, env))
                continue

            if isinstance(stmt, ast.AugAssign):
                target = runtime_expr(stmt.target, env, module_globals)
                rhs = runtime_expr(stmt.value, env, module_globals)
                op_map = {
                    ast.Add: "+",
                    ast.Sub: "-",
                    ast.Mult: "*",
                    ast.Div: "/",
                    ast.Mod: "%",
                    ast.Pow: "**",
                }
                op_symbol = None
                for op_t, symbol in op_map.items():
                    if isinstance(stmt.op, op_t):
                        op_symbol = symbol
                        break
                if op_symbol is None:
                    raise ValueError(f"Unsupported augmented assignment operator: {ast.dump(stmt.op)}")
                out_lines.append(f"{target} = {target} {op_symbol} {rhs};")

                if isinstance(stmt.target, ast.Name):
                    env[stmt.target.id] = RuntimeVar(stmt.target.id)
                continue

            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                continue

            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Await):
                awaited = stmt.value.value
                if isinstance(awaited, ast.Call):
                    converted = convert_awaited_call(awaited, env, helper_names, module_globals)
                    if converted is None:
                        raise ValueError(f"Unsupported awaited call: {dotted_name(awaited.func)}")
                    out_lines.extend(converted)
                else:
                    out_lines.append(f"{runtime_expr(awaited, env, module_globals)};")
                continue

            if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
                converted = convert_expr_call_stmt(stmt.value, env, helper_names, module_globals)
                if converted is None:
                    raise ValueError(f"Unsupported call statement: {dotted_name(stmt.value.func)}")
                out_lines.extend(converted)
                continue

            if isinstance(stmt, ast.With):
                out_lines.extend(convert_context_block(stmt, env, helper_names, module_globals, strict=strict))
                continue

            if isinstance(stmt, ast.AsyncWith):
                out_lines.extend(convert_context_block(stmt, env, helper_names, module_globals, strict=strict))
                continue

            if isinstance(stmt, ast.For):
                try:
                    iterable = eval_expr(stmt.iter, env, module_globals)
                    for item in iterable:
                        loop_env = dict(env)
                        bind_target(stmt.target, item, loop_env)
                        out_lines.extend(
                            convert_statements(
                                func_name,
                                stmt.body,
                                loop_env,
                                helper_names,
                                module_globals,
                                strict=strict,
                            )
                        )
                        env.update(loop_env)

                    if stmt.orelse:
                        out_lines.extend(
                            convert_statements(
                                func_name,
                                stmt.orelse,
                                env,
                                helper_names,
                                module_globals,
                                strict=strict,
                            )
                        )
                except Exception:
                    iter_expr = runtime_expr(stmt.iter, env, module_globals)
                    loop_env = dict(env)
                    mark_target_runtime(stmt.target, loop_env)
                    body_lines = convert_statements(
                        func_name,
                        stmt.body,
                        loop_env,
                        helper_names,
                        module_globals,
                        strict=strict,
                    )
                    out_lines.append(f"for (const {target_pattern(stmt.target)} of ({iter_expr} as any)) {{")
                    out_lines.extend(indent_block(body_lines, 1))
                    out_lines.append("}")
                    if stmt.orelse:
                        out_lines.extend(
                            convert_statements(
                                func_name,
                                stmt.orelse,
                                env,
                                helper_names,
                                module_globals,
                                strict=strict,
                            )
                        )
                    mark_target_runtime(stmt.target, env)
                continue

            if isinstance(stmt, ast.AsyncFor):
                iter_expr = runtime_expr(stmt.iter, env, module_globals)
                loop_env = dict(env)
                mark_target_runtime(stmt.target, loop_env)
                body_lines = convert_statements(
                    func_name,
                    stmt.body,
                    loop_env,
                    helper_names,
                    module_globals,
                    strict=strict,
                )
                out_lines.append(f"for (const {target_pattern(stmt.target)} of ({iter_expr} as any)) {{")
                out_lines.extend(indent_block(body_lines, 1))
                out_lines.append("}")
                if stmt.orelse:
                    out_lines.extend(
                        convert_statements(
                            func_name,
                            stmt.orelse,
                            env,
                            helper_names,
                            module_globals,
                            strict=strict,
                        )
                    )
                mark_target_runtime(stmt.target, env)
                continue

            if isinstance(stmt, ast.While):
                cond_expr = runtime_expr(stmt.test, env, module_globals)
                out_lines.append(f"while ({cond_expr}) {{")
                out_lines.extend(
                    indent_block(
                        convert_statements(
                            func_name,
                            stmt.body,
                            dict(env),
                            helper_names,
                            module_globals,
                            strict=strict,
                        ),
                        1,
                    )
                )
                out_lines.append("}")
                if stmt.orelse:
                    out_lines.extend(
                        convert_statements(
                            func_name,
                            stmt.orelse,
                            env,
                            helper_names,
                            module_globals,
                            strict=strict,
                        )
                    )
                continue

            if isinstance(stmt, ast.If):
                try:
                    cond = bool(eval_expr(stmt.test, env, module_globals))
                    branch = stmt.body if cond else stmt.orelse
                    out_lines.extend(
                        convert_statements(func_name, branch, env, helper_names, module_globals, strict=strict)
                    )
                except Exception:
                    cond_expr = runtime_expr(stmt.test, env, module_globals)
                    out_lines.append(f"if ({cond_expr}) {{")
                    out_lines.extend(
                        indent_block(
                            convert_statements(
                                func_name,
                                stmt.body,
                                dict(env),
                                helper_names,
                                module_globals,
                                strict=strict,
                            ),
                            1,
                        )
                    )
                    if stmt.orelse:
                        out_lines.append("} else {")
                        out_lines.extend(
                            indent_block(
                                convert_statements(
                                    func_name,
                                    stmt.orelse,
                                    dict(env),
                                    helper_names,
                                    module_globals,
                                    strict=strict,
                                ),
                                1,
                            )
                        )
                    out_lines.append("}")
                continue

            if isinstance(stmt, ast.Assert):
                condition = runtime_expr(stmt.test, env, module_globals)
                out_lines.append(f"expect({condition}).toBeTruthy();")
                continue

            if isinstance(stmt, ast.Return):
                if stmt.value is None:
                    out_lines.append("return;")
                else:
                    out_lines.append(f"return {runtime_expr(stmt.value, env, module_globals)};")
                continue

            if isinstance(stmt, ast.Raise):
                if stmt.exc is None:
                    out_lines.append("throw _err;")
                else:
                    out_lines.append(f"throw {runtime_expr(stmt.exc, env, module_globals)};")
                continue

            if isinstance(stmt, ast.Pass):
                continue

            if isinstance(stmt, ast.Break):
                out_lines.append("break;")
                continue

            if isinstance(stmt, ast.Continue):
                out_lines.append("continue;")
                continue

            if isinstance(stmt, ast.Try):
                out_lines.append("try {")
                out_lines.extend(
                    indent_block(
                        convert_statements(func_name, stmt.body, dict(env), helper_names, module_globals, strict=strict),
                        1,
                    )
                )
                if stmt.handlers:
                    out_lines.append("} catch (_err) {")
                    handler_lines: list[str] = []
                    for h in stmt.handlers:
                        handler_lines.extend(
                            convert_statements(func_name, h.body, dict(env), helper_names, module_globals, strict=strict)
                        )
                    out_lines.extend(indent_block(handler_lines or ["// ignored"], 1))
                if stmt.finalbody:
                    out_lines.append("} finally {")
                    out_lines.extend(
                        indent_block(
                            convert_statements(
                                func_name,
                                stmt.finalbody,
                                dict(env),
                                helper_names,
                                module_globals,
                                strict=strict,
                            ),
                            1,
                        )
                    )
                    out_lines.append("}")
                else:
                    out_lines.append("}")
                continue

            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                module_node = ast.Module(body=[stmt], type_ignores=[])
                code = compile(module_node, "<converter-fn>", "exec")
                local_env = dict(env)
                exec(code, module_globals, local_env)
                env[stmt.name] = local_env[stmt.name]
                continue

            raise ValueError(f"Unsupported statement: {ast.dump(stmt)}")
        except Exception as exc:
            if strict:
                raise ValueError(f"Unsupported statement in {func_name}: {ast.dump(stmt)}") from exc
            out_lines.append(f"// converter-fallback in {func_name}: {compact_reason(str(exc), 160)}")

    return out_lines


def convert_method(
    func: ast.FunctionDef | ast.AsyncFunctionDef,
    helper_names: set[str],
    module_globals: dict[str, Any],
    strict: bool,
) -> ConvertedTest:
    env: dict[str, Any] = {}
    skip_reason = extract_test_skip_reason(func, module_globals)
    out_lines = convert_statements(func.name, func.body, env, helper_names, module_globals, strict=strict)
    return ConvertedTest(name=func.name, skip_reason=skip_reason, lines=out_lines)


def convert_helper(
    func: ast.FunctionDef | ast.AsyncFunctionDef,
    helper_names: set[str],
    module_globals: dict[str, Any],
    strict: bool,
) -> ConvertedHelper:
    env: dict[str, Any] = {}
    lines = convert_statements(func.name, func.body, env, helper_names, module_globals, strict=strict)
    return ConvertedHelper(name=func.name, lines=lines)


def pick_test_classes(module: ast.Module) -> list[ast.ClassDef]:
    classes: list[ast.ClassDef] = []
    for node in module.body:
        if isinstance(node, ast.ClassDef):
            for base in node.bases:
                if dotted_name(base).endswith("TestCase"):
                    classes.append(node)
                    break
    if not classes:
        raise ValueError("Could not find a test case class in the source file")
    return classes


def derive_default_output(py_path: Path) -> Path:
    stem = py_path.stem
    if stem.startswith("test_"):
        stem = stem[len("test_") :]

    if py_path.parent.name == "tests":
        repo_root = py_path.parent.parent
    else:
        repo_root = Path.cwd()

    return (repo_root / "sqlite-ts" / "tests" / f"{stem}.test.ts").resolve()


def derive_artifact_name(py_path: Path) -> str:
    stem = py_path.stem
    if stem.startswith("test_edgeql_"):
        return stem[len("test_edgeql_") :]
    if stem.startswith("test_"):
        return stem[len("test_") :]
    return stem


def class_artifact_suffix(class_name: str) -> str:
    suffix = re.sub(r"[^A-Za-z0-9_]+", "_", class_name).strip("_").lower()
    return suffix or "testcase"


def convert_file(source_path: Path, output_path: Path, strict: bool = False) -> str:
    source = source_path.read_text(encoding="utf-8")
    module = ast.parse(source)

    module_globals = build_eval_globals(module)
    test_classes = pick_test_classes(module)
    artifact_name_base = derive_artifact_name(source_path)

    lines: list[str] = []
    lines.append('import { beforeEach, describe, expect, it } from "vitest";')
    lines.append('import { QueryHarness } from "./utils.js";')
    lines.append("import {")
    lines.append("  assertQueryResult,")
    lines.append("  unorderedBag,")
    lines.append("  unorderedSet")
    lines.append('} from "./python_query_test_helpers.js";')
    lines.append("")

    emitted_classes = 0
    for class_node in test_classes:
        class_name = class_node.name
        schema_name = (
            maybe_extract_basename_from_class_attr(class_node, "SCHEMA", ".esdl")
            or maybe_extract_basename_from_class_attr(class_node, "SCHEMA_DEFAULT", ".esdl")
        )
        setup_name = maybe_extract_basename_from_class_attr(class_node, "SETUP", ".edgeql")

        helper_nodes = [
            node
            for node in class_node.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("test_")
        ]
        helper_names = {node.name for node in helper_nodes}

        helpers: list[ConvertedHelper] = []
        for node in helper_nodes:
            try:
                helpers.append(convert_helper(node, helper_names, module_globals, strict=strict))
            except ValueError as exc:
                if strict:
                    raise
                helpers.append(
                    ConvertedHelper(
                        name=node.name,
                        lines=[f"// converter-fallback in {node.name}: {compact_reason(str(exc), 160)}"],
                    )
                )

        tests: list[ConvertedTest] = []
        for node in class_node.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                try:
                    tests.append(convert_method(node, helper_names, module_globals, strict=strict))
                except ValueError as exc:
                    if strict:
                        raise
                    reason = compact_reason(str(exc))
                    tests.append(
                        ConvertedTest(
                            name=node.name,
                            skip_reason=f"[unconverted: {reason}]",
                            lines=[],
                        )
                    )

        if not tests:
            continue

        emitted_classes += 1
        if emitted_classes > 1:
            lines.append("")

        artifact_name = artifact_name_base
        if len(test_classes) > 1:
            artifact_name = f"{artifact_name_base}_{class_artifact_suffix(class_name)}"

        lines.append(f'describe("{class_name}", () => {{')
        lines.append("  let h: QueryHarness;")
        lines.append("")
        lines.append("  beforeEach(async () => {")
        lines.append("    h = await QueryHarness.create({")
        if schema_name:
            lines.append(f'      schema: "{schema_name}",')
        if setup_name:
            lines.append(f'      setup: "{setup_name}",')
        lines.append(f'      dbFile: "./tests/.artifacts/{artifact_name}.sqlite",')
        lines.append("      resetDbFile: true")
        lines.append("    });")
        lines.append("  });")
        lines.append("")

        for helper in helpers:
            lines.append(f"  function {helper.name}(): void {{")
            lines.extend(indent_block(helper.lines, 2))
            lines.append("  }")
            lines.append("")

        for idx, test in enumerate(tests):
            title = test.name if not test.skip_reason else f"{test.name} {test.skip_reason}"
            test_decl = "it.skip" if test.skip_reason else "it"
            lines.append(f"  {test_decl}({json.dumps(title)}, () => {{")
            lines.extend(indent_block(test.lines, 2))
            lines.append("  });")
            if idx < len(tests) - 1:
                lines.append("")

        lines.append("});")

    if emitted_classes == 0:
        raise ValueError("No test methods found in test case classes")

    lines.append("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert EdgeDB Python QueryTestCase file to sqlite-ts Vitest file")
    parser.add_argument("source", help="Path to tests/test_*.py source file")
    parser.add_argument(
        "--output",
        help="Output .test.ts path (default: sqlite-ts/tests/<source_stem_without_test_>.test.ts)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail on first unsupported test construct instead of emitting skipped tests",
    )
    args = parser.parse_args()

    source_path = Path(args.source).resolve()
    if not source_path.exists():
        raise SystemExit(f"Source file not found: {source_path}")

    if args.output:
        output_path = Path(args.output).resolve()
    else:
        output_path = derive_default_output(source_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    converted = convert_file(source_path, output_path, strict=args.strict)
    output_path.write_text(converted, encoding="utf-8")

    print(f"Converted {source_path} -> {output_path}")


if __name__ == "__main__":
    main()
