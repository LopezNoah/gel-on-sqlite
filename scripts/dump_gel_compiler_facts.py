#!/usr/bin/env python3
"""Dump normalized Gel compiler facts for sqlite-ts debugging.

This intentionally records compact, stable-ish semantic facts instead of raw
Python object dumps: IR kind skeletons, PathIds, scope tree text, inference
facts, and optionally PostgreSQL SQL. It is meant for focused goldens around
sqlite-ts failing clusters, not wholesale dumping every upstream test.

Run from the repository root or from sqlite-ts, for example:

    python3 scripts/dump_gel_compiler_facts.py --preset scope_computables_08

or:

    python3 scripts/dump_gel_compiler_facts.py \
      --schema-file ../tests/schemas/cards.esdl \
      --query 'SELECT count((Card.owners.name, Card.owners.deck_cost));'
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import pathlib
import re
import sys
import traceback
from dataclasses import dataclass
from typing import Any


SCRIPT = pathlib.Path(__file__).resolve()
SQLITE_TS_ROOT = SCRIPT.parents[1]
REPO_ROOT = SQLITE_TS_ROOT.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# edb must run in "dev mode" to work from a source checkout: it then resolves
# the version from git (via SCM) instead of installed distribution metadata,
# and caches the std schema as a pickle for fast subsequent runs. The dev-mode
# cache dir's parent must exist first — edb's own mkdir() is not recursive.
os.environ.setdefault("__EDGEDB_DEVMODE", "1")
(REPO_ROOT / "build" / "cache").mkdir(parents=True, exist_ok=True)


try:
    from edb import buildmeta  # noqa: E402
    from edb import edgeql  # noqa: E402
    from edb import errors  # noqa: E402
    from edb.edgeql import ast as qlast  # noqa: E402
    from edb.edgeql import compiler as ql_compiler  # noqa: E402
    from edb.edgeql import parser as ql_parser  # noqa: E402
    from edb.edgeql import qltypes  # noqa: E402
    from edb.pgsql import codegen as pg_codegen  # noqa: E402
    from edb.pgsql import compiler as pg_compiler  # noqa: E402
    from edb.common import debug  # noqa: E402
    from edb.common import devmode  # noqa: E402
    from edb.common.ast import base as ast_base  # noqa: E402
    from edb.schema import ddl as s_ddl  # noqa: E402
    from edb.schema import delta as sd  # noqa: E402
    from edb.schema import migrations as s_migrations  # noqa: E402,F401
    from edb.schema import modules as s_mod  # noqa: E402
    from edb.schema import schema as s_schema  # noqa: E402
    from edb.schema import std as s_std  # noqa: E402
    from edb.schema import utils as s_utils  # noqa: E402
except ModuleNotFoundError as exc:  # pragma: no cover - command-line error path
    missing = exc.name or "<unknown>"
    sys.stderr.write(
        f"Missing Python dependency {missing!r}.\n"
        "Install the minimal deps for this dump script with:\n\n"
        "    python3 -m pip install 'parsing~=2.0' 'immutables>=0.18'\n\n"
        "or install them into a scratch target and run with PYTHONPATH:\n\n"
        "    python3 -m pip install --target /tmp/gel-pydeps "
        "'parsing~=2.0' 'immutables>=0.18'\n"
        "    PYTHONPATH=/tmp/gel-pydeps python3 "
        "sqlite-ts/scripts/dump_gel_compiler_facts.py ...\n"
    )
    raise SystemExit(1) from exc


# Inlined from edb.testbase.lang to avoid importing edb.server.compiler (which
# drags in graphql / native server extensions we don't need for IR/SQL facts).

_std_schema = None


def _load_std_schema():
    global _std_schema
    if _std_schema is None:
        std_dirs_hash = buildmeta.hash_dirs(s_std.CACHE_SRC_DIRS)
        schema = None

        if devmode.is_in_dev_mode():
            schema = buildmeta.read_data_cache(
                std_dirs_hash, 'transient-stdschema.pickle')

        if schema is None:
            schema = s_schema.EMPTY_SCHEMA
            for modname in [*s_schema.STD_SOURCES, *s_schema.TESTMODE_SOURCES]:
                schema = s_std.load_std_module(schema, modname)
            schema, _ = s_std.make_schema_version(schema)
            schema, _ = s_std.make_global_schema_version(schema)

        if devmode.is_in_dev_mode():
            buildmeta.write_data_cache(
                schema, std_dirs_hash, 'transient-stdschema.pickle')

        _std_schema = schema

    return _std_schema


def run_ddl(
    schema,
    ddl,
    default_module=s_mod.DEFAULT_MODULE_ALIAS,
    skip_non_ddl=False,
):
    statements = edgeql.parse_block(ddl)

    current_schema = schema
    target_schema = None
    migration_schema = None
    migration_target = None
    migration_script = []

    for stmt in statements:
        ddl_plan = None
        if isinstance(stmt, qlast.StartMigration):
            # START MIGRATION
            if target_schema is None:
                target_schema = _load_std_schema()

            migration_target, _ = s_ddl.apply_sdl(
                stmt.target,
                base_schema=target_schema,
                testmode=True,
            )

            migration_schema = current_schema

            ddl_plan = None

        elif isinstance(stmt, qlast.PopulateMigration):
            # POPULATE MIGRATION
            if migration_target is None:
                raise errors.QueryError(
                    'unexpected POPULATE MIGRATION:'
                    ' not currently in a migration block',
                    span=stmt.span,
                )

            migration_diff = s_ddl.delta_schemas(
                migration_schema,
                migration_target,
            )

            new_ddl = s_ddl.ddlast_from_delta(
                migration_schema,
                migration_target,
                migration_diff,
            )

            migration_script.extend(new_ddl)

        elif isinstance(stmt, qlast.DescribeCurrentMigration):
            if stmt.language is qltypes.DescribeLanguage.JSON:
                guided_diff = s_ddl.delta_schemas(
                    migration_schema,
                    migration_target,
                    generate_prompts=True,
                )
                s_ddl.statements_from_delta(
                    schema,
                    migration_target,
                    guided_diff,
                )

        elif isinstance(stmt, qlast.CommitMigration):
            if migration_target is None:
                raise errors.QueryError(
                    'unexpected COMMIT MIGRATION:'
                    ' not currently in a migration block',
                    span=stmt.span,
                )

            last_migration = current_schema.get_last_migration()
            if last_migration:
                last_migration_ref = s_utils.name_to_ast_ref(
                    last_migration.get_name(current_schema),
                )
            else:
                last_migration_ref = None

            create_migration = qlast.CreateMigration(
                body=qlast.NestedQLBlock(commands=migration_script),
                parent=last_migration_ref,
            )

            ddl_plan = s_ddl.delta_from_ddl(
                create_migration,
                schema=migration_schema,
                modaliases={None: default_module},
                testmode=True,
            )

            migration_schema = None
            migration_target = None
            migration_script = []

        elif isinstance(stmt, qlast.DDLCommand):
            if migration_target is not None:
                migration_script.append(stmt)
                ddl_plan = None
            else:
                ddl_plan = s_ddl.delta_from_ddl(
                    stmt,
                    schema=current_schema,
                    modaliases={None: default_module},
                    testmode=True,
                )
        else:
            if skip_non_ddl:
                # Setup scripts mix DDL with DML (INSERT/SET MODULE/SELECT).
                # Only schema-affecting statements matter for IR/SQL facts;
                # skip the rest instead of failing the whole setup.
                continue
            raise ValueError(
                f'unexpected {stmt!r} in compiler setup script')

        if ddl_plan is not None:
            context = sd.CommandContext()
            context.testmode = True
            current_schema = ddl_plan.apply(current_schema, context)

    return current_schema


CARDS_SCHEMA = REPO_ROOT / "tests" / "schemas" / "cards.esdl"

PRESETS: dict[str, tuple[pathlib.Path, str]] = {
    "scope_computables_07a": (
        CARDS_SCHEMA,
        """
        WITH U := User { cards := .deck },
        SELECT count((U.cards.name, U.cards.cost));
        """,
    ),
    "scope_computables_07b": (
        CARDS_SCHEMA,
        """
        WITH U := User { cards := Card },
        SELECT count((U.cards.name, U.cards.cost));
        """,
    ),
    "scope_computables_07c": (
        CARDS_SCHEMA,
        """
        WITH U := (SELECT User { cards := Card }
                   FILTER .name = "Phil"),
        SELECT count((U.cards.name, U.cards.cost));
        """,
    ),
    "scope_computables_08": (
        CARDS_SCHEMA,
        """
        SELECT count((Card.owners.name, Card.owners.deck_cost));
        """,
    ),
    "scope_computables_11a": (
        CARDS_SCHEMA,
        """
        SELECT count((Card.owners.name, Card.owners.deck_cost, Card.name));
        """,
    ),
}


@dataclass(frozen=True)
class ExtractedQuery:
    source_file: pathlib.Path
    class_name: str
    test_name: str
    case_index: int
    # One (module_name, sdl_text) pair per SCHEMA* class attribute.
    schema_modules: tuple[tuple[str, str], ...]
    schema_label: str
    # Ordered DDL/migration setup that must run before the query compiles:
    # class SETUP plus any inline self.con.execute / self.migrate statements
    # that precede the assert in the test method body.
    setup_ddl: tuple[str, ...]
    query: str | None
    extract_error: str | None = None


_schema_cache: dict[tuple[tuple[str, str], ...], Any] = {}


def load_schema(schema_file: pathlib.Path):
    schema_text = schema_file.read_text()
    return load_schema_modules(
        (("default", schema_text),), str(schema_file.resolve()))


def load_schema_text(schema_text: str, schema_label: str):
    return load_schema_modules((("default", schema_text),), schema_label)


def load_schema_modules(
    schema_modules: tuple[tuple[str, str], ...],
    schema_label: str,
):
    # Cache on the concrete module SDL, not the human label: two classes with
    # different labels but identical schema share the compiled schema.
    cache_key = tuple(schema_modules)
    cached = _schema_cache.get(cache_key)
    if cached is not None:
        return cached

    schema = _load_std_schema()
    # Always materialize an (at least empty) `default` module so that inline
    # setup DDL targeting default:: has a module to land in — mirrors the
    # original single-schema loader, which migrated `module default { ... }`.
    modules = {module: (sdl or "") for module, sdl in schema_modules}
    modules.setdefault("default", "")
    module_blocks = [
        f" module {module} {{ {sdl} }} "
        for module, sdl in modules.items()
    ]
    script = (
        "START MIGRATION TO {"
        + "".join(module_blocks)
        + "}; POPULATE MIGRATION; COMMIT MIGRATION;"
    )
    schema = run_ddl(schema, script)

    _schema_cache[cache_key] = schema
    return schema


def apply_setup(schema, setup_ddl: tuple[str, ...]):
    """Apply ordered setup statements onto the loaded schema, best-effort.

    Setup scripts freely mix schema DDL with DML (INSERT/SET MODULE/SELECT),
    which is irrelevant to IR/SQL facts, and may include declarative SDL passed
    to self.migrate. Each chunk is tried as an imperative DDL block first, then
    as an SDL migration; anything that still fails (duplicate creates, DML-only,
    unsupported features) is skipped so the query can still compile against
    whatever schema we managed to build.
    """
    for text in setup_ddl:
        chunk = (text or "").strip()
        if not chunk:
            continue
        try:
            schema = run_ddl(schema, chunk, skip_non_ddl=True)
            continue
        except Exception:
            pass
        try:
            wrapped = (
                "START MIGRATION TO { module default { "
                + chunk
                + " } }; POPULATE MIGRATION; COMMIT MIGRATION;"
            )
            schema = run_ddl(schema, wrapped, skip_non_ddl=True)
        except Exception:
            # Un-appliable setup chunk; leave the schema as-is.
            pass
    return schema


def load_batch_helpers():
    try:
        import convert_py_query_test as pytests  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - command-line error path
        raise RuntimeError(
            "batch extraction needs scripts/convert_py_query_test.py to import"
        ) from exc
    return pytests


def stable_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return value or "case"


def test_file_group(py_file: pathlib.Path) -> str:
    stem = py_file.stem
    if stem.startswith("test_"):
        stem = stem[len("test_"):]
    return stable_name(stem)


def source_location(source_file: pathlib.Path, node: ast.AST) -> dict[str, Any]:
    return {
        "file": str(source_file.relative_to(REPO_ROOT)),
        "line": getattr(node, "lineno", None),
    }


def _text_from_path(path: pathlib.Path) -> str | None:
    try:
        return path.read_text()
    except Exception:
        return None


def _repo_relative_label(path: pathlib.Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _resolve_file_node(
    value: ast.AST,
    source_file: pathlib.Path,
    pytests: Any,
    exts: tuple[str, ...],
) -> pathlib.Path | None:
    """Resolve a constant path or os.path.join(...) ending in one of exts."""
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        if value.value.endswith(exts):
            path = pathlib.Path(value.value)
            if not path.is_absolute():
                path = source_file.parent / path
            return path.resolve()
        return None
    if isinstance(value, ast.Call) and pytests.dotted_name(value.func) == "os.path.join":
        literal_parts = [
            arg.value
            for arg in value.args
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
        ]
        # Upstream joins as os.path.join(os.path.dirname(__file__), 'schemas', 'x').
        idx = next(
            (i for i, part in enumerate(literal_parts) if part.endswith(exts)),
            None,
        )
        if idx is not None:
            return source_file.parent.joinpath(*literal_parts[:idx + 1]).resolve()
    return None


def _schema_text_for_attr(
    value: ast.AST,
    source_file: pathlib.Path,
    module_globals: dict[str, Any],
    pytests: Any,
    class_name: str,
) -> tuple[str | None, str]:
    path = _resolve_file_node(value, source_file, pytests, (".esdl",))
    if path is not None:
        return _text_from_path(path), _repo_relative_label(path)

    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        digest = hashlib.sha1(value.value.encode()).hexdigest()[:12]
        return value.value, f"inline:{class_name}:{digest}"

    if isinstance(value, (ast.List, ast.Tuple)):
        for item in value.elts:
            text, label = _schema_text_for_attr(
                item, source_file, module_globals, pytests, class_name)
            if text is not None:
                return text, label
        return None, "empty"

    try:
        evaluated = pytests.eval_expr(value, {}, module_globals)
    except Exception:
        return None, "unresolved"
    if isinstance(evaluated, (list, tuple)):
        evaluated = next(
            (item for item in evaluated
             if isinstance(item, str) and item.endswith(".esdl")),
            evaluated[0] if evaluated else "",
        )
    if isinstance(evaluated, str) and evaluated.endswith(".esdl"):
        return _text_from_path(pathlib.Path(evaluated).resolve()), evaluated
    if isinstance(evaluated, str):
        digest = hashlib.sha1(evaluated.encode()).hexdigest()[:12]
        return evaluated, f"inline:{class_name}:{digest}"
    return None, "unresolved"


def schema_modules_from_class(
    source_file: pathlib.Path,
    class_node: ast.ClassDef,
    module_globals: dict[str, Any],
    pytests: Any,
) -> tuple[tuple[tuple[str, str], ...], str]:
    """Collect SCHEMA / SCHEMA_<MODULE> attrs into (module, sdl_text) pairs.

    SCHEMA and SCHEMA_DEFAULT map to module ``default``; SCHEMA_TEST →
    ``test``, SCHEMA_CARDS → ``cards``, etc.
    """
    modules: dict[str, str] = {}
    labels: list[str] = []
    for stmt in class_node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if not isinstance(target, ast.Name):
                continue
            attr = target.id
            if attr != "SCHEMA" and not attr.startswith("SCHEMA_"):
                continue
            module = (
                "default" if attr in ("SCHEMA", "SCHEMA_DEFAULT")
                else attr[len("SCHEMA_"):].lower()
            )
            text, label = _schema_text_for_attr(
                stmt.value, source_file, module_globals, pytests,
                class_node.name)
            if text is not None and module not in modules:
                modules[module] = text
                labels.append(label)

    if not modules:
        return (), "empty"
    schema_modules = tuple(sorted(modules.items()))
    return schema_modules, ";".join(labels)


def setup_texts_from_class(
    source_file: pathlib.Path,
    class_node: ast.ClassDef,
    module_globals: dict[str, Any],
    pytests: Any,
) -> tuple[str, ...]:
    out: list[str] = []

    def walk(node: ast.AST) -> None:
        if isinstance(node, (ast.List, ast.Tuple)):
            for el in node.elts:
                walk(el)
            return
        path = _resolve_file_node(node, source_file, pytests, (".edgeql", ".esdl"))
        if path is not None:
            text = _text_from_path(path)
            if text:
                out.append(text)
            return
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append(node.value)
            return
        try:
            evaluated = pytests.eval_expr(node, {}, module_globals)
        except Exception:
            return
        items = evaluated if isinstance(evaluated, (list, tuple)) else [evaluated]
        for item in items:
            if not isinstance(item, str):
                continue
            if item.endswith((".edgeql", ".esdl")):
                text = _text_from_path(pathlib.Path(item).resolve())
                if text:
                    out.append(text)
            else:
                out.append(item)

    for stmt in class_node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        if any(isinstance(t, ast.Name) and t.id == "SETUP" for t in stmt.targets):
            walk(stmt.value)
            break
    return tuple(out)


def method_map(class_node: ast.ClassDef) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return {
        node.name: node
        for node in class_node.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def effective_method_map(
    class_node: ast.ClassDef,
    module_classes: dict[str, ast.ClassDef],
    _seen: frozenset[str] = frozenset(),
) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    """Methods of class_node plus methods inherited from module-local bases.

    Lets self.<helper>() and bare references to mixin methods (e.g. dump
    tests' ensure_schema_data_integrity) resolve. Subclass methods win.
    """
    if class_node.name in _seen:
        return {}
    seen = _seen | {class_node.name}
    methods: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    for base in class_node.bases:
        base_name = (
            base.id if isinstance(base, ast.Name)
            else base.attr if isinstance(base, ast.Attribute)
            else None
        )
        base_cls = module_classes.get(base_name) if base_name else None
        if base_cls is not None:
            methods.update(effective_method_map(base_cls, module_classes, seen))
    methods.update(method_map(class_node))
    return methods


def extract_queries_from_method(
    *,
    source_file: pathlib.Path,
    class_name: str,
    test_name: str,
    method: ast.FunctionDef | ast.AsyncFunctionDef,
    methods: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
    schema_modules: tuple[tuple[str, str], ...],
    schema_label: str,
    class_setup: tuple[str, ...],
    module_globals: dict[str, Any],
    pytests: Any,
) -> list[ExtractedQuery]:
    out: list[ExtractedQuery] = []
    case_index = 0
    # Inline DDL executed (self.con.execute / self.migrate) before each assert,
    # accumulated in source order. Shared across the whole method walk so a
    # query sees every schema change that precedes it.
    ddl_acc: list[str] = []

    def append_case(
        query: str | None,
        node: ast.AST,
        error: str | None = None,
    ) -> None:
        nonlocal case_index
        case_index += 1
        detail = error
        if detail is not None:
            loc = source_location(source_file, node)
            detail = f"{detail} at {loc['file']}:{loc['line']}"
        out.append(ExtractedQuery(
            source_file=source_file,
            class_name=class_name,
            test_name=test_name,
            case_index=case_index,
            schema_modules=schema_modules,
            schema_label=schema_label,
            setup_ddl=tuple(class_setup) + tuple(ddl_acc),
            query=query,
            extract_error=detail,
        ))

    def record_ddl(call: ast.Call, env: dict[str, Any], *, migrate: bool) -> None:
        if not call.args:
            return
        try:
            text = pytests.eval_expr(call.args[0], env, module_globals)
        except Exception:
            return
        if not isinstance(text, str):
            return
        if migrate:
            # self.migrate(sdl) is a declarative migration to the given schema.
            text = (
                "START MIGRATION TO { module default { "
                + text
                + " } }; POPULATE MIGRATION; COMMIT MIGRATION;"
            )
        ddl_acc.append(text)

    def process_call(call: ast.Call, env: dict[str, Any], stack: tuple[str, ...]) -> bool:
        func_name = pytests.dotted_name(call.func)
        if func_name == "self.assert_query_result":
            if not call.args:
                append_case(None, call, "assert_query_result has no query argument")
                return True
            try:
                query = pytests.eval_expr(call.args[0], env, module_globals)
                if not isinstance(query, str):
                    raise ValueError("query argument did not evaluate to a string")
                append_case(query, call)
            except Exception as exc:
                append_case(None, call, str(exc))
            return True

        if func_name in ("self.con.execute", "self.con.query",
                         "self.con.query_single", "self.con._fetchall"):
            record_ddl(call, env, migrate=False)
            return True

        if func_name == "self.migrate":
            record_ddl(call, env, migrate=True)
            return True

        if func_name.startswith("self."):
            helper_name = func_name[len("self."):]
            helper = methods.get(helper_name)
            if helper is not None and helper_name not in stack:
                helper_env = dict(env)
                params = helper.args.args[1:]  # skip self
                try:
                    for param, arg in zip(params, call.args):
                        helper_env[param.arg] = pytests.eval_expr(arg, env, module_globals)
                    for kw in call.keywords:
                        if kw.arg:
                            helper_env[kw.arg] = pytests.eval_expr(
                                kw.value, env, module_globals)
                except Exception:
                    # Fall through with the bindings we could evaluate; any
                    # unevaluable query expression will be recorded per-case.
                    pass
                process_statements(helper.body, helper_env, (*stack, helper_name))
                return True

        return False

    def process_expr(expr: ast.AST, env: dict[str, Any], stack: tuple[str, ...]) -> None:
        if isinstance(expr, ast.Await):
            process_expr(expr.value, env, stack)
            return
        if isinstance(expr, ast.Call):
            if process_call(expr, env, stack):
                return
        # A helper method passed by reference (e.g. dump tests pass
        # DumpTestCaseMixin.ensure_schema_data_integrity to a framework runner).
        # Treat the reference as an entry point so its asserts are extracted.
        if isinstance(expr, (ast.Attribute, ast.Name)):
            ref = expr.attr if isinstance(expr, ast.Attribute) else expr.id
            helper = methods.get(ref)
            if helper is not None and ref not in stack:
                process_statements(helper.body, dict(env), (*stack, ref))
                return
        for child in ast.iter_child_nodes(expr):
            process_expr(child, env, stack)

    def process_statements(
        statements: list[ast.stmt],
        env: dict[str, Any],
        stack: tuple[str, ...],
    ) -> None:
        for stmt in statements:
            if isinstance(stmt, ast.Assign):
                try:
                    value = pytests.eval_expr(stmt.value, env, module_globals)
                    for target in stmt.targets:
                        pytests.bind_target(target, value, env)
                    continue
                except Exception:
                    process_expr(stmt.value, env, stack)
                    continue

            if isinstance(stmt, ast.AnnAssign):
                try:
                    if stmt.value is not None:
                        value = pytests.eval_expr(stmt.value, env, module_globals)
                        pytests.bind_target(stmt.target, value, env)
                    continue
                except Exception:
                    if stmt.value is not None:
                        process_expr(stmt.value, env, stack)
                    continue

            if isinstance(stmt, (ast.For, ast.AsyncFor)):
                try:
                    if isinstance(stmt, ast.AsyncFor):
                        raise ValueError("async iterables are not evaluable")
                    iterable = pytests.eval_expr(stmt.iter, env, module_globals)
                    for item in iterable:
                        nested = dict(env)
                        pytests.bind_target(stmt.target, item, nested)
                        process_statements(stmt.body, nested, stack)
                    process_statements(stmt.orelse, dict(env), stack)
                except Exception:
                    process_statements(stmt.body, dict(env), stack)
                    process_statements(stmt.orelse, dict(env), stack)
                continue

            if isinstance(stmt, (ast.With, ast.AsyncWith)):
                process_statements(stmt.body, dict(env), stack)
                continue

            if isinstance(stmt, ast.If):
                try:
                    branch = stmt.body if pytests.eval_expr(
                        stmt.test, env, module_globals) else stmt.orelse
                    process_statements(branch, dict(env), stack)
                except Exception:
                    process_statements(stmt.body, dict(env), stack)
                    process_statements(stmt.orelse, dict(env), stack)
                continue

            if isinstance(stmt, (ast.Try, ast.TryStar)):
                process_statements(stmt.body, dict(env), stack)
                for handler in stmt.handlers:
                    process_statements(handler.body, dict(env), stack)
                process_statements(stmt.orelse, dict(env), stack)
                process_statements(stmt.finalbody, dict(env), stack)
                continue

            if isinstance(stmt, ast.Expr):
                process_expr(stmt.value, env, stack)

    process_statements(method.body, {}, (method.name,))
    return out


def extract_queries_from_test_file(source_file: pathlib.Path) -> list[ExtractedQuery]:
    pytests = load_batch_helpers()
    source = source_file.read_text(encoding="utf-8")
    module = ast.parse(source)
    module_globals = pytests.build_eval_globals(module)
    module_globals["__file__"] = str(source_file)

    module_classes = {
        node.name: node
        for node in module.body
        if isinstance(node, ast.ClassDef)
    }

    extracted: list[ExtractedQuery] = []
    for class_node in pytests.pick_test_classes(module):
        schema_modules, schema_label = schema_modules_from_class(
            source_file,
            class_node,
            module_globals,
            pytests,
        )
        class_setup = setup_texts_from_class(
            source_file,
            class_node,
            module_globals,
            pytests,
        )
        methods = effective_method_map(class_node, module_classes)
        for node in class_node.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not node.name.startswith("test_"):
                continue
            extracted.extend(extract_queries_from_method(
                source_file=source_file,
                class_name=class_node.name,
                test_name=node.name,
                method=node,
                methods=methods,
                schema_modules=schema_modules,
                schema_label=schema_label,
                class_setup=class_setup,
                module_globals=module_globals,
                pytests=pytests,
            ))

    return extracted


def expand_test_files(patterns: list[str], all_tests: bool) -> list[pathlib.Path]:
    paths: list[pathlib.Path] = []
    if all_tests:
        tests_dir = REPO_ROOT / "tests"
        paths.extend(sorted(tests_dir.glob("test_edgeql_*.py")))
        paths.extend(sorted(tests_dir.glob("test_dump*.py")))
    for pattern in patterns:
        pattern_path = pathlib.Path(pattern)
        if pattern_path.is_absolute():
            parent = pattern_path.parent
            expanded = sorted(parent.glob(pattern_path.name))
        else:
            expanded = sorted(pathlib.Path().glob(pattern))
        if not expanded:
            expanded = sorted(REPO_ROOT.glob(pattern))
        if not expanded:
            expanded = [pathlib.Path(pattern)]
        paths.extend(path.resolve() for path in expanded)

    deduped: list[pathlib.Path] = []
    seen: set[pathlib.Path] = set()
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        deduped.append(resolved)
    return deduped


def enum_value(value: Any) -> Any:
    return getattr(value, "value", str(value))


def type_name(typeref: Any) -> str | None:
    if typeref is None:
        return None
    name = getattr(typeref, "name_hint", None)
    return str(name) if name is not None else None


def path_id_text(path_id: Any) -> str | None:
    if path_id is None:
        return None
    try:
        return path_id.pformat_internal(debug=True)
    except Exception:
        return str(path_id)


def is_ast(value: Any) -> bool:
    return isinstance(value, ast_base.AST)


def iter_ast_fields(node: Any):
    for name, field in getattr(type(node), "_fields", {}).items():
        if field.hidden:
            continue
        if hasattr(node, name):
            yield name, getattr(node, name)


KIND_FIELDS = (
    "expr",
    "result",
    "where",
    "orderby",
    "order_by",
    "limit",
    "offset",
    "iterator_stmt",
    "iterator",
    "body",
    "subject",
    "args",
    "elements",
    "shape",
    "left",
    "right",
)


def kind_tree(node: Any, *, depth: int = 0, max_depth: int = 7) -> Any:
    if depth > max_depth:
        return "..."
    if node is None:
        return None
    if isinstance(node, (str, int, float, bool)):
        return node
    if isinstance(node, (list, tuple)):
        return [kind_tree(v, depth=depth + 1, max_depth=max_depth) for v in node]
    if isinstance(node, dict):
        return {
            str(k): kind_tree(v, depth=depth + 1, max_depth=max_depth)
            for k, v in sorted(node.items(), key=lambda kv: str(kv[0]))
        }
    if not is_ast(node):
        return type(node).__name__

    out: dict[str, Any] = {"kind": type(node).__name__}

    path_id = getattr(node, "path_id", None)
    if path_id is not None:
        out["path_id"] = path_id_text(path_id)

    typeref = getattr(node, "typeref", None) or getattr(node, "stype", None)
    if typeref is not None:
        out["type"] = type_name(typeref)

    for field_name in KIND_FIELDS:
        if not hasattr(node, field_name):
            continue
        value = getattr(node, field_name)
        if value in (None, [], (), {}):
            continue
        out[field_name] = kind_tree(
            value,
            depth=depth + 1,
            max_depth=max_depth,
        )

    return out


def collect_path_ids(node: Any, *, limit: int = 300) -> list[dict[str, Any]]:
    seen_obj: set[int] = set()
    seen_paths: set[str] = set()
    result: list[dict[str, Any]] = []

    def walk(value: Any, owner: str = "") -> None:
        if len(result) >= limit:
            return
        if value is None or isinstance(value, (str, int, float, bool)):
            return
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, str(k))
            return
        if isinstance(value, (list, tuple, set, frozenset)):
            for v in value:
                walk(v, owner)
            return
        oid = id(value)
        if oid in seen_obj:
            return
        seen_obj.add(oid)

        if is_ast(value):
            path_id = getattr(value, "path_id", None)
            if path_id is not None:
                text = path_id_text(path_id)
                if text is not None and text not in seen_paths:
                    seen_paths.add(text)
                    result.append({
                        "path_id": text,
                        "owner": owner or type(value).__name__,
                        "node": type(value).__name__,
                        "expr": type(getattr(value, "expr", None)).__name__
                        if getattr(value, "expr", None) is not None
                        else None,
                        "type": type_name(
                            getattr(value, "typeref", None)
                            or getattr(value, "stype", None)
                        ),
                    })
            for name, child in iter_ast_fields(value):
                walk(child, name)

    walk(node)
    return result


def compile_facts(
    *,
    schema_modules: tuple[tuple[str, str], ...],
    schema_label: str | None = None,
    setup_ddl: tuple[str, ...] = (),
    query: str,
    include_sql: bool,
    max_depth: int,
) -> dict[str, Any]:
    schema = load_schema_modules(schema_modules, schema_label or "inline")
    schema_fact = schema_label or "inline"
    if setup_ddl:
        schema = apply_setup(schema, setup_ddl)

    # parse_query expects a single fragment, not a trailing ';' terminator.
    qltree = ql_parser.parse_query(query.strip().rstrip(";"))
    ir = ql_compiler.compile_ast_to_ir(
        qltree,
        schema,
        options=ql_compiler.CompilerOptions(modaliases={None: "default"}),
    )

    facts: dict[str, Any] = {
        "schema_file": schema_fact,
        "query": "\n".join(line.rstrip() for line in query.strip().splitlines()),
        "inference": {
            "cardinality": enum_value(getattr(ir, "cardinality", None)),
            "multiplicity": enum_value(getattr(ir, "multiplicity", None)),
            "volatility": enum_value(getattr(ir, "volatility", None)),
            "stype": type_name(getattr(ir, "stype", None)),
        },
        "ir_kind_tree": kind_tree(ir, max_depth=max_depth),
        "path_ids": collect_path_ids(ir),
        "scope_tree": ir.scope_tree.pdebugformat(fuller=True)
        if getattr(ir, "scope_tree", None) is not None
        else None,
    }

    if include_sql:
        sql_tree = pg_compiler.compile_ir_to_sql_tree(
            ir,
            output_format=pg_compiler.OutputFormat.NATIVE,
        )
        facts["postgres_sql"] = pg_codegen.generate_source(
            sql_tree.ast,
            pretty=True,
        )

    return facts


def write_batch_golden(
    *,
    case: ExtractedQuery,
    output_path: pathlib.Path,
    include_sql: bool,
    max_depth: int,
) -> dict[str, Any]:
    source = {
        "file": str(case.source_file.relative_to(REPO_ROOT)),
        "class": case.class_name,
        "test": case.test_name,
        "case_index": case.case_index,
    }

    if case.extract_error is not None or case.query is None:
        record = {
            "ok": False,
            "source_test": source,
            "schema_file": case.schema_label,
            "error": {
                "phase": "extract",
                "message": case.extract_error or "query was not extracted",
            },
        }
    else:
        try:
            record = compile_facts(
                schema_modules=case.schema_modules,
                schema_label=case.schema_label,
                setup_ddl=case.setup_ddl,
                query=case.query,
                include_sql=include_sql,
                max_depth=max_depth,
            )
            record["ok"] = True
            record["source_test"] = source
        except Exception as exc:
            record = {
                "ok": False,
                "source_test": source,
                "schema_file": case.schema_label,
                "query": "\n".join(
                    line.rstrip() for line in case.query.strip().splitlines()),
                "error": {
                    "phase": "compile",
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc().splitlines(),
                },
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(record, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return record


def batch_output_path(out_dir: pathlib.Path, case: ExtractedQuery) -> pathlib.Path:
    source_group = test_file_group(case.source_file)
    class_group = stable_name(case.class_name)
    file_name = f"{stable_name(case.test_name)}__{case.case_index:03d}.json"
    return out_dir / source_group / class_group / file_name


def run_batch(args: argparse.Namespace) -> None:
    test_files = expand_test_files(args.test_file or [], args.all_tests)
    if not test_files:
        raise SystemExit("No test files matched. Pass --all-tests or --test-file.")

    test_name_re = re.compile(args.test_name) if args.test_name else None
    out_dir = args.out_dir.resolve()

    manifest: dict[str, Any] = {
        "out_dir": str(out_dir.relative_to(SQLITE_TS_ROOT)
                       if out_dir.is_relative_to(SQLITE_TS_ROOT) else out_dir),
        "include_sql": bool(args.sql),
        "max_depth": args.max_depth,
        "cases": [],
        "counts": {"ok": 0, "error": 0, "skipped_existing": 0},
    }

    processed = 0
    for test_file in test_files:
        try:
            cases = extract_queries_from_test_file(test_file)
        except Exception as exc:
            # Some tests/test_edgeql_*.py files (e.g. the ir_* IR-inspection
            # suites) are not QueryTestCase classes and have no extractable
            # assert_query_result calls. Record and skip instead of aborting
            # the whole batch.
            manifest["counts"].setdefault("skipped_files", 0)
            manifest["counts"]["skipped_files"] += 1
            manifest.setdefault("skipped_files", []).append({
                "source": str(test_file.relative_to(REPO_ROOT)
                              if test_file.is_relative_to(REPO_ROOT)
                              else test_file),
                "reason": f"{type(exc).__name__}: {exc}",
            })
            continue
        for case in cases:
            if test_name_re and not test_name_re.search(case.test_name):
                continue
            if args.limit is not None and processed >= args.limit:
                break
            processed += 1

            output_path = batch_output_path(out_dir, case)
            manifest_case = {
                "source": str(case.source_file.relative_to(REPO_ROOT)),
                "class": case.class_name,
                "test": case.test_name,
                "case_index": case.case_index,
                "output": str(output_path.relative_to(SQLITE_TS_ROOT)
                              if output_path.is_relative_to(SQLITE_TS_ROOT)
                              else output_path),
            }

            if output_path.exists() and not args.overwrite:
                manifest["counts"]["skipped_existing"] += 1
                manifest_case["status"] = "skipped_existing"
                manifest["cases"].append(manifest_case)
                continue

            record = write_batch_golden(
                case=case,
                output_path=output_path,
                include_sql=args.sql,
                max_depth=args.max_depth,
            )
            if record.get("ok") is True:
                manifest["counts"]["ok"] += 1
                manifest_case["status"] = "ok"
            else:
                manifest["counts"]["error"] += 1
                manifest_case["status"] = "error"
                manifest_case["error"] = record.get("error")
            manifest["cases"].append(manifest_case)

        if args.limit is not None and processed >= args.limit:
            break

    manifest_path = (args.manifest or (out_dir / "manifest.json")).resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        "Wrote "
        f"{manifest['counts']['ok']} ok, "
        f"{manifest['counts']['error']} errors, "
        f"{manifest['counts']['skipped_existing']} skipped to {out_dir}"
    )
    print(f"Manifest: {manifest_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Dump normalized Gel compiler facts as JSON.",
    )
    parser.add_argument(
        "--preset",
        choices=sorted(PRESETS),
        help="Named query preset. Uses tests/schemas/cards.esdl.",
    )
    parser.add_argument("--schema-file", type=pathlib.Path)
    parser.add_argument("--query")
    parser.add_argument(
        "--query-file",
        type=pathlib.Path,
        help="Read query text from a file instead of --query.",
    )
    parser.add_argument(
        "--sql",
        action="store_true",
        help="Also include generated PostgreSQL SQL.",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=7,
        help="Maximum depth for the IR kind skeleton.",
    )
    parser.add_argument("--out", type=pathlib.Path)
    parser.add_argument(
        "--all-tests",
        action="store_true",
        help="Extract assert_query_result queries from all tests/test_edgeql_*.py files.",
    )
    parser.add_argument(
        "--test-file",
        action="append",
        help="Python test file or glob to extract. May be passed more than once.",
    )
    parser.add_argument(
        "--test-name",
        help="Regex filter applied to Python test method names in batch mode.",
    )
    parser.add_argument(
        "--out-dir",
        type=pathlib.Path,
        default=SQLITE_TS_ROOT / "goldens" / "gel-compiler-facts",
        help="Output directory for --all-tests/--test-file batch goldens.",
    )
    parser.add_argument(
        "--manifest",
        type=pathlib.Path,
        help="Manifest path for batch mode. Defaults to <out-dir>/manifest.json.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Stop after N extracted query cases in batch mode.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing batch golden files.",
    )
    args = parser.parse_args()

    if args.all_tests or args.test_file:
        if args.preset or args.schema_file or args.query or args.query_file or args.out:
            parser.error(
                "batch mode cannot be combined with --preset, --schema-file, "
                "--query, --query-file, or --out"
            )
        run_batch(args)
        return

    if args.preset:
        schema_file, query = PRESETS[args.preset]
    else:
        if not args.schema_file:
            parser.error("--schema-file is required without --preset")
        if bool(args.query) == bool(args.query_file):
            parser.error("pass exactly one of --query or --query-file")
        schema_file = args.schema_file
        query = args.query_file.read_text() if args.query_file else args.query

    schema_file = schema_file.resolve()
    facts = compile_facts(
        schema_modules=(("default", schema_file.read_text()),),
        schema_label=str(schema_file.relative_to(REPO_ROOT))
        if schema_file.is_relative_to(REPO_ROOT) else str(schema_file),
        query=query,
        include_sql=args.sql,
        max_depth=args.max_depth,
    )

    text = json.dumps(facts, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
