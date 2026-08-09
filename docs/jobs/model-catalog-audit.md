Verify the curated agent model catalog against the locally installed CLIs and report (or fix) any drift. This job is mechanical by design: the script does the verification; your judgment is only needed to decide what to do about what it finds.

## What to run

From the repo root:

```
pnpm tsx scripts/audit-agent-models.ts
```

The script cross-checks `AGENT_MODEL_OPTIONS` in `apps/server/src/shared/agent-models.ts` against the installed Codex CLI's model registries (the install-wide registry embedded in the binary plus the per-account `~/.codex/models_cache.json`), the Claude Code binary's accepted ids, `cursor-agent --list-models` (only if Cursor entries exist), and the "Known upcoming retirements" dates in `docs/agent-model-catalog.md`.

- **Exit 0, no notes** — nothing to do. Report done with a one-line summary.
- **Exit 1 (drift)** — an entry the CLIs can't vouch for, an unlabeled entry backed only by per-account evidence, or a past-due retirement. Open a fix PR on a fresh worktree branch: remove or relabel the flagged entries following the evidence rules in `docs/agent-model-catalog.md`, run the pre-completion checks from `CLAUDE.md`, and do NOT merge without approval.
- **Exit 0 with notes** — informational only (e.g. a registry model the catalog omits, or a retirement date approaching). Mention notes in your report; adding new models is a human decision, so do not add entries yourself unless the note is a retirement warning whose date-driven removal is already documented.

## Rules

- Never run `codex`, `claude`, or `cursor-agent` in a way that starts an agent session or consumes account quota. The script only reads local binaries/caches; `--list-models` is the one permitted account-touching call and only fires when Cursor entries exist.
- Keep any fix PR scoped to the catalog, its labels, and `docs/agent-model-catalog.md`. No adjacent refactors.
- Report the outcome via the job reporting tools with the script's output included.
