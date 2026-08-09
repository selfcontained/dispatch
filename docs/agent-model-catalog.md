# Agent model catalog

Dispatch exposes a source-controlled model catalog for its Codex and Claude
launchers in `apps/server/src/shared/agent-models.ts`. The catalog is
the allowlist used by the create-agent API and `dispatch_launch_agent` MCP tool.
Omitting a model uses the CLI default. Agent types with no catalog entry
(currently Cursor) hide the model picker entirely and always launch with the
CLI default.

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
  registry before adding it: `~/.codex/models_cache.json` holds the remote
  catalog the CLI actually serves (each entry's `slug` is the accepted ID), and
  `strings $(readlink -f $(which codex)) | grep '"slug"'` exposes the embedded
  fallback registry. Doc prose and config examples (e.g. `model = "gpt-5.6"`)
  are not evidence that a slug exists — the CLI silently reroutes unknown
  models to the account default, so a bogus ID fails only subtly.
- **Claude Code:** Check the Claude Code CLI reference. It supports the moving
  `opus`, `sonnet`, and `haiku` aliases plus documented full model IDs; add a
  full ID when it is available to the intended account.
- **Cursor Agent:** No curated list ships on purpose. Cursor's model roster is
  account- and plan-dependent, its public docs list display names rather than
  verified CLI slugs, and a logged-out `cursor-agent` reports no models at all —
  so no entry in a static catalog can be verified. Launches use the CLI
  default. To re-add options, run `cursor-agent --list-models` on the
  logged-in account Dispatch runs under and use those exact slugs.

Keep the `Default` UI option untouched: it deliberately sends no model flag.
Update the catalog, its labels, and this document when a provider adds, retires,
or renames a model. Dispatch rejects IDs outside this curated catalog; a
freeform model-ID setting is a separate future feature.

When removing an id, first check for active agents using it: selected models
persist in `agents.model` and are passed through unchanged on resume. Existing
agents with a retired id can therefore fail at the CLI until their model is
changed or the provider restores the id. Run the relevant server tests plus
`pnpm run check` before opening a draft PR.
