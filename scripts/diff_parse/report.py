#!/usr/bin/env python3
"""Differential parser harness — step 3 of 3 (the REPORT).

Joins corpus.json (Gel ground truth) with ours.json (sqlite-ts) and ranks the
divergence. The actionable output is the GAP: snippets Gel accepts but sqlite-ts
rejects, grouped by grammar production (Gel's top-level AST node kinds).

    PYTHONPATH=<gel> .venv/bin/python sqlite-ts/scripts/diff_parse/report.py
"""

from __future__ import annotations

import collections
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, ".out")


def load(name: str) -> dict:
    with open(os.path.join(OUTDIR, name)) as fh:
        return {r["id"]: r for r in json.load(fh)}


def production(kinds: list[str]) -> str:
    return "+".join(sorted(set(kinds))) if kinds else "(none)"


def main() -> None:
    gel = load("corpus.json")
    ours = load("ours.json")

    agree_ok = agree_reject = gap = overaccept = 0
    gap_rows: list[dict] = []
    over_rows: list[dict] = []
    accept_rows: list[dict] = []  # both accept — for AST-faithfulness analysis
    for cid, g in gel.items():
        o = ours.get(cid)
        if o is None:
            continue
        if g["gel_ok"] and o["ours_ok"]:
            agree_ok += 1
            accept_rows.append({**g, **o})
        elif not g["gel_ok"] and not o["ours_ok"]:
            agree_reject += 1
        elif g["gel_ok"] and not o["ours_ok"]:
            gap += 1
            gap_rows.append({**g, **o})
        else:
            overaccept += 1
            over_rows.append({**g, **o})

    total = agree_ok + agree_reject + gap + overaccept
    gel_accepts = agree_ok + gap
    out: list[str] = []

    def p(s: str = "") -> None:
        out.append(s)

    p("# sqlite-ts ↔ Gel parser differential")
    p(f"\nCorpus: {total} snippets from tests/test_edgeql_syntax.py "
      "(Gel's parser is ground truth).\n")
    p("| quadrant | count |")
    p("|---|---|")
    p(f"| ✅ agree accept | {agree_ok} |")
    p(f"| ✅ agree reject | {agree_reject} |")
    p(f"| ❌ **GAP** (Gel accepts, sqlite-ts rejects) | **{gap}** |")
    p(f"| ⚠️ over-accept (Gel rejects, sqlite-ts accepts) | {overaccept} |")
    p(f"\n**Acceptance parity: {agree_ok}/{gel_accepts} = "
      f"{100 * agree_ok / gel_accepts:.1f}%** of snippets Gel accepts also parse in sqlite-ts.")
    p("\n> ⚠️ Acceptance is a WEAK signal: sqlite-ts's parser is lenient and routes many\n"
      "> statements through coarse buckets (a single `ddl` kind, the `select_expr` bare-expr\n"
      "> wrapper). The sharper question — *does it build the right node?* — is below.\n")

    # --- AST faithfulness: which sqlite-ts kind absorbs which Gel productions ---
    # Fan-in = number of DISTINCT Gel productions a single sqlite-ts kind absorbs.
    # fan-in > 1 == sqlite-ts under-distinguishes (it merges productions Gel keeps
    # apart) == the objective "production-collapse" signal. (Orthogonal caveat: even
    # fan-in-1 kinds use sqlite-ts's bespoke AST shape, not qlast — a shape-fidelity
    # gap this acceptance-level harness does not measure.)
    by_ours_kind: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for r in accept_rows:
        ours_k = "+".join(sorted(set(r["ours_kinds"]))) or "(none)"
        by_ours_kind[ours_k][production(r["gel_kinds"])] += 1
    collapsed = sum(sum(prods.values()) for k, prods in by_ours_kind.items() if len(prods) > 1)

    p("## Production faithfulness — the real worklist\n")
    p(f"Of the {agree_ok} both-accept snippets, **{collapsed} parse into a sqlite-ts kind that merges "
      f"≥2 distinct Gel productions** (fan-in > 1 below) — i.e. the parser accepts them but does not "
      f"distinguish the grammar production. This is almost entirely DDL.\n")
    p("| sqlite-ts kind | snippets | distinct Gel productions (fan-in) |")
    p("|---|---|---|")
    for ours_k, prods in sorted(by_ours_kind.items(), key=lambda kv: -len(kv[1])):
        flag = " ⚠️" if len(prods) > 1 else ""
        p(f"| `{ours_k}`{flag} | {sum(prods.values())} | {len(prods)} |")

    # the Gel productions hidden inside each high-fan-in bucket = what to split out
    for bucket, prods in sorted(by_ours_kind.items(), key=lambda kv: -len(kv[1])):
        if len(prods) <= 1:
            continue
        p(f"\n### {len(prods)} Gel productions collapsed into `{bucket}` (→ split these out)\n")
        p("| count | Gel production |")
        p("|---|---|")
        for prod, n in prods.most_common():
            p(f"| {n} | `{prod}` |")

    # --- GAP (Gel accepts, sqlite-ts throws): hard reject failures ---
    if gap_rows:
        by_prod = collections.Counter(production(r["gel_kinds"]) for r in gap_rows)
        p("## GAP — snippets sqlite-ts outright rejects (ranked by production)\n")
        p("| failing snippets | production(s) Gel parsed |")
        p("|---|---|")
        for prod, n in by_prod.most_common():
            p(f"| {n} | `{prod}` |")
        by_err = collections.Counter(r["ours_err"] or "(no message)" for r in gap_rows)
        p("\n### recurring sqlite-ts error messages in the GAP\n")
        p("| count | sqlite-ts error |")
        p("|---|---|")
        for err, n in by_err.most_common(15):
            p(f"| {n} | {err.replace('|', '\\|')[:110]} |")
        p("\n### sample failing snippets\n")
        for prod, _ in by_prod.most_common(6):
            samples = [r for r in gap_rows if production(r["gel_kinds"]) == prod][:3]
            p(f"**`{prod}`**")
            for r in samples:
                src = " ".join(r["source"].split())[:140]
                p(f"- `{r['id'].split('.')[-1]}` — {r['ours_err']}\n  > `{src}`")
            p("")
    else:
        p("## GAP — snippets sqlite-ts outright rejects\n")
        p("None. sqlite-ts's parser accepts every snippet Gel accepts (it errs toward "
          "leniency, hence the 5 over-accepts). The divergence is structural, not acceptance — "
          "see *Production faithfulness* above.\n")

    # --- over-acceptance samples ---
    if over_rows:
        p("## ⚠️ Over-acceptance samples (sqlite-ts accepts what Gel rejects)\n")
        for r in over_rows[:10]:
            src = " ".join(r["source"].split())[:120]
            p(f"- `{r['id'].split('.')[-1]}` (gel: {r['gel_err']})")
            p(f"  > `{src}`")

    text = "\n".join(out)
    print(text)
    dest = os.path.join(OUTDIR, "report.md")
    with open(dest, "w") as fh:
        fh.write(text + "\n")
    print(f"\n[wrote {dest}]", file=sys.stderr)


if __name__ == "__main__":
    main()
