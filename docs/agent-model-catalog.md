# Agent model catalog

Dispatch exposes a source-controlled model catalog for its Codex, Claude, and
Cursor launchers in `apps/server/src/shared/agent-models.ts`. The catalog is
the allowlist used by the create-agent API and `dispatch_launch_agent` MCP tool.
Omitting a model uses the CLI default.

## Maintenance sources

- [Codex model selection](https://learn.chatgpt.com/docs/models.md)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Cursor Agent CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)
- [Cursor models](https://docs.cursor.com/models/)

## Updating the catalog

Use only provider documentation. Confirm that a candidate both appears in the
provider's current catalog and is accepted by that CLI's `--model` flag. Keep
the `Default` UI option untouched: it deliberately sends no model flag. Update
the catalog, its labels, and this document if a source URL changes. Run the
relevant server tests plus `pnpm run check` before opening a draft PR.
