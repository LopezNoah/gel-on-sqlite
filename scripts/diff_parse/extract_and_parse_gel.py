#!/usr/bin/env python3
"""Differential parser harness — step 1 of 3 (the GROUND TRUTH side).

Extracts an EdgeQL corpus from Gel's own parser test suite
(tests/test_edgeql_syntax.py — 719 hand-written snippets) and records what
Gel's real parser does with each one. Gel is the oracle: `gel_ok` is whether
`edgeql.parse_block` accepts the snippet, and `gel_kinds` are the top-level AST
node class names (= grammar productions: SelectQuery, InsertQuery,
CreateObjectType, ...).

Corpus extraction is done with Python's own `ast` module (no regex): each
`test_*` method's docstring is the snippet; the framework splits it on
`\\n% OK %` and parses the part before, so we do the same.

Run from the repo root:
    PYTHONPATH=<gel> .venv/bin/python sqlite-ts/scripts/diff_parse/extract_and_parse_gel.py

Writes <outdir>/corpus.json. Default outdir is the .out dir next to this script.
"""

from __future__ import annotations

import ast
import json
import os
import sys

import edb.edgeql as eql


HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TEST_FILE = os.path.join(REPO, "tests", "test_edgeql_syntax.py")
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".out")


def decorator_is_must_fail(dec: ast.expr) -> bool:
    target = dec.func if isinstance(dec, ast.Call) else dec
    if isinstance(target, ast.Attribute):
        return target.attr == "must_fail"
    if isinstance(target, ast.Name):
        return target.id == "must_fail"
    return False


def extract_snippets(path: str) -> list[dict]:
    """Statically extract (id, source, expected_fail) from a syntax test file."""
    with open(path) as fh:
        tree = ast.parse(fh.read(), filename=path)

    snippets: list[dict] = []
    for cls in ast.walk(tree):
        if not isinstance(cls, ast.ClassDef):
            continue
        for fn in cls.body:
            if not isinstance(fn, ast.FunctionDef) or not fn.name.startswith("test_"):
                continue
            doc = ast.get_docstring(fn, clean=False)
            if not doc:
                continue
            source = doc.partition("\n% OK %")[0]
            if not source.strip():
                continue
            expected_fail = any(decorator_is_must_fail(d) for d in fn.decorator_list)
            snippets.append({
                "id": f"{cls.name}.{fn.name}",
                "source": source,
                "expected_fail": expected_fail,
            })
    return snippets


def run_gel(source: str) -> dict:
    try:
        stmts = eql.parse_block(source)
        return {"gel_ok": True, "gel_kinds": [type(s).__name__ for s in stmts], "gel_err": None}
    except Exception as e:  # noqa: BLE001 — any parse failure is ground-truth reject
        msg = str(e).splitlines()[0] if str(e) else ""
        return {"gel_ok": False, "gel_kinds": [], "gel_err": f"{type(e).__name__}: {msg}"[:200]}


def main() -> None:
    snippets = extract_snippets(TEST_FILE)
    for s in snippets:
        s.update(run_gel(s["source"]))

    os.makedirs(OUTDIR, exist_ok=True)
    dest = os.path.join(OUTDIR, "corpus.json")
    with open(dest, "w") as fh:
        json.dump(snippets, fh, indent=1)

    ok = sum(1 for s in snippets if s["gel_ok"])
    print(f"corpus: {len(snippets)} snippets from {os.path.relpath(TEST_FILE, REPO)}")
    print(f"  gel accepts {ok}, rejects {len(snippets) - ok}")
    print(f"  wrote {dest}")


if __name__ == "__main__":
    main()
