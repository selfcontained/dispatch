# Agent model catalog

Dispatch exposes a source-controlled model catalog for its Codex and Claude
launchers in `apps/server/src/shared/agent-models.ts`. The catalog is
the allowlist used by the create-agent API and `dispatch_launch_agent` MCP tool.
Omitting a model uses the CLI default. Agent types with no catalog entry
(currently Cursor and OpenCode) hide the model picker entirely and always
launch with the CLI default.

## Maintenance sources

- [Codex model selection](https://learn.chatgpt.com/docs/models.md)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)

## Updating the catalog

Use only the provider documentation linked above. Before adding an ID, verify
that it is accepted by the relevant launcher, not merely available in a
provider API:

- **Codex:** Check the Codex model-selection documentation for IDs supported by
  the installed Codex CLI. Include current coding-capable model aliases and
  variants, but exclude API-only models such as embeddings, image, audio, and
  moderation models. Cross-check every ID against the installed CLI's model
  registry before adding it. Two registries exist, and they are not
  interchangeable evidence:
  - The **embedded fallback registry** — install-wide, shipped in the binary;
    inspect with `strings $(readlink -f $(which codex)) | grep '"slug"'`. This
    is the bar for an unlabeled entry: a slug here exists for every account.
  - The **remote catalog cache** at `~/.codex/models_cache.json` — per-account
    (each entry's `slug` is the accepted ID). A slug found only here may not
    exist for other accounts; add it with a qualifier in its label (e.g.
    "(preview)") or hold it until it reaches the embedded registry.

  Doc prose and config examples (e.g. `model = "gpt-5.6"`) are not evidence
  that a slug exists — the CLI silently reroutes unknown models to the account
  default, so a bogus ID fails only subtly.

- **Claude Code:** Check the Claude Code CLI reference. It supports the moving
  `opus`, `sonnet`, and `haiku` aliases plus documented full model IDs; add a
  full ID when it is available to the intended account.
- **Cursor Agent:** The same rule applies — entries must be cross-checked
  against the installed CLI's model registry — and no Cursor list has passed
  that bar yet: its public docs carry display names rather than verified CLI
  slugs, and a logged-out `cursor-agent` reports no models at all. Until a
  verified list exists, Cursor has no catalog entry and launches use the CLI
  default. To add one on the same terms as Codex, run
  `cursor-agent --list-models` on the logged-in account Dispatch runs under
  and use those exact slugs.

Keep the `Default` UI option untouched: it deliberately sends no model flag.
Update the catalog, its labels, and this document when a provider adds, retires,
or renames a model. Dispatch rejects IDs outside this curated catalog; a
freeform model-ID setting is a separate future feature.

When removing an id, first check for active agents using it: selected models
persist in `agents.model` and are passed through unchanged on resume. Existing
agents with a retired id can therefore fail at the CLI until their model is
changed or the provider restores the id. Stored models on templates and jobs
are normalized in the UI: `useAgentModelCatalog`'s `normalizeModel` maps ids
absent from the loaded catalog to Default at save time, so removed ids don't
strand their edit forms. Run the relevant server tests plus `pnpm run check`
before opening a draft PR.

## Repeatable audit

`pnpm tsx scripts/audit-agent-models.ts` re-verifies the whole catalog against
the installed CLIs mechanically — the Codex binary's embedded registry and
per-account cache, the Claude binary's accepted ids, `cursor-agent
--list-models` when Cursor entries exist, and the retirement dates below. It
exits 1 on drift. Run it whenever you edit the catalog; it also backs the
recurring `model-catalog-audit` Dispatch job (prompt in
`docs/jobs/model-catalog-audit.md`) so drift is caught without anyone
re-deriving the evidence by hand.

## Known upcoming retirements

Check this list on every catalog edit and prune entries whose date has passed.

- `gpt-5.4` and `gpt-5.4-mini` retire **2026-08-31** (successors:
  `gpt-5.6-terra` and `gpt-5.6-luna`). Remove both entries around that date.
