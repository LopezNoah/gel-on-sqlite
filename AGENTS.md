<!-- gitbutler-agent-setup:start -->
## Version control

- Use GitButler (`but`) for version-control inspection and write operations, including status, diffs, branching, committing, pushing, and history edits.
- Assume multiple agents may be working in this repository. Do not move, amend, squash, discard, commit, push, or otherwise modify another agent's work unless the user asks.
- For commit just/only/specific changes on a new branch (selected-change requests), use the two-command fast path from the GitButler skill: `but diff`, then `but commit <branch> -c -m "message" --changes <id>,<id>`.
- For that fast path, after the commit succeeds, stop and summarize; do not run separate branch, staging, status, or diff commands unless the commit output is missing information you need.
- Use the installed GitButler skill for command recipes and syntax before guessing flags, using `--help`, or translating Git habits directly.
- After a successful GitButler write command, use the workspace state it returns. Rerun status or diff only when that output lacks information you need or files changed since.
- Use a dedicated GitButler branch for each agent session, unless the user asks for a different branch structure. Commit only changes that belong to that session.
- Do not push or open pull requests unless the user asks.
- Keep commit messages and pull request descriptions succinct: explain what changed, why it changed, and any important decision.

### Amend local fixes into the right commits

- For small cleanup or follow-up fixes, amend an unpublished local commit when the change clearly belongs with that commit's intent.
- Do not create tiny fixup commits unless the user asks.
- Use GitButler to move the relevant changes into the commit where they belong.
- Ask before rewriting pushed, reviewed, shared, or ambiguous history.

### Split unrelated changes into separate commits

- If one file contains unrelated changes, split them by hunk instead of committing the whole file.
- Keep tests with the behavior they verify.
- Split generated output, docs-only edits, or mechanical cleanup into separate commits when each commit remains coherent on its own.
- If the split is ambiguous, summarize the options before committing.

### Create stacked pull requests

- If this session depends on another in-flight branch, stack its branch on top of that dependency instead of mixing the changes.
- If this session is working in a stack, put commits on the branch where they belong.
- Ask before moving commits onto lower, pushed, reviewed, or shared branches.
- Use `but move` for branch stacking and restacking. Do not recreate branches to simulate stacking.
- For stacked branches, create pull requests with `but pr`, not `gh`, so GitButler keeps the right PR base branches and stack metadata.

### Branch naming

- When creating a GitButler branch for an agent session, use `<name>/<short-description>`.

### Commit message convention

- Follow the `type(scope): summary` commit-message convention when writing commit messages.

### Commit checkpoints after each turn

- Commit after a working checkpoint, when the requested change is complete and relevant checks have passed or been reported.
- Treat checkpoint commits as local savepoints, not final review history.
- When the user asks you to tidy the history, use GitButler to squash commits, reword commits, and move changes between commits where appropriate.
- Only tidy unpublished local history unless the user explicitly authorizes changing pushed or shared history.
<!-- gitbutler-agent-setup:end -->
