# Agent model catalog

Dispatch exposes a source-controlled suggested model catalog for its Codex,
Claude, and Cursor launchers in `apps/server/src/shared/agent-models.ts`.
Suggestions make common choices convenient, but Dispatch accepts any non-empty
model ID and passes it to the selected provider CLI. The provider CLI and
account determine whether an ID is available. Omitting a model uses the CLI
default.

## Maintenance sources

- [Codex model selection](https://learn.chatgpt.com/docs/models.md)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Cursor Agent CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
- [Cursor models](https://docs.cursor.com/models/)

## Updating the catalog

Use only provider documentation. Confirm that a candidate both appears in the
provider's current catalog and is accepted by that CLI's `--model` flag. Keep
the empty `Default (CLI setting)` UI option untouched: it deliberately sends no
model flag. Update the catalog, its labels, and this document if a source URL
changes.

When removing an id, first check for active agents using it: selected models
persist in `agents.model` and are passed through unchanged on resume. Existing
agents with a retired id can therefore fail at the CLI until their model is
changed or the provider restores the id. Run the relevant server tests plus
`pnpm run check` before opening a draft PR.
