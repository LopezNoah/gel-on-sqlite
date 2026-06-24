# Root-level debug runners are intentional local scratch, not repo clutter

A round-10 architecture review carded "delete ~24 dead `.ts` scratch files at
the repo root" (`qsql.ts`, `qfn.ts`, `qins.ts`, `cdbg.ts`, `csql.ts`, `sdbg.ts`,
`dbg_*.ts`, `*_scratch.ts`, `v13[a–i]_scratch.ts`, …) as a navigability win,
having observed them in the working tree.

**Finding (the candidate's premise was wrong):** every one of those files is
already **gitignored** — `.gitignore` has a dedicated *"Local debug runners
(developer scratch files at repo root)"* section listing them explicitly and by
glob (`/dbg_*.ts`, `/*_scratch.ts`, `/q*.ts`, …); `git check-ignore` confirms
all of them are excluded. They are **not** tracked, and they do **not** appear
in the repository as any teammate or agent clones it. The only tracked root
`.ts` files are `sql_trace.ts` (a permanent debug tool, kept by round 7) and
`vitest.config.ts`. The explorer saw the working tree; the *repository* root is
already clean.

**Decision (done — no code change):** do nothing. There is no navigability debt
at the repository level to pay. The files are intentional, gitignored, local
developer scratch; deleting them would only tidy one checkout's working tree —
not the project — and they belong to whoever's checkout it is. We do not delete
local gitignored files we did not create.

**Consequences.** Candidate 6 is closed as a non-issue. `sql_trace.ts` stays
(tracked, live tooling, imported conceptually alongside
`src/runtime/sql_trace_sink.ts`).

**Why record it.** A future architecture review will again walk the working tree,
see the same scratch files, and re-card "delete the dead root files." It is not
dead code and it is not clutter in the repo — it is deliberately gitignored
local scratch. Recording this once stops the re-suggestion.
