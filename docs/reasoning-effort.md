# Per-agent reasoning effort

Dispatch resolves launch effort in this order: explicit launch value, column trigger override, template, app default. Null or an absent field inherits the next level. Effort never inherits from the launching agent. New installations and existing settings without a saved default use `medium`. In Settings → Agent types, choose CLI settings to clear the app default; this is stored as JSON null, distinct from an absent setting.

`GET /api/v1/app/settings/effort` returns `{ "effort": "medium" }` (or null). `POST` to the same path accepts `{ "effort": null }` to defer to engine configuration, or a supported Claude level. Existing sessions retain their resolved launch effort when restarted; changing templates or the app default affects new sessions only.

## Entry points

- `create_template`, `update_template`, and `get_template`: nullable `effort`.
- `task_column_update`: nullable `trigger.effort`; `task_list` includes it in column metadata. `trigger_launched.configuration.effort` records the resolved value, including the app default.
- `launch_agent`: nullable `effort`, with explicit value taking precedence over template. Template model, directory and access defaults are now honored too; a child cannot gain greater tool access than its launcher.
- HTTP direct, template, task and job launches accept effort. Scheduled jobs use their backing template. Editors show the same selector; cards and `list_agents` show the resolved launch value.

## Runtime behavior

Claude accepts `low`, `medium`, `high`, `xhigh`, and `max`. Dispatch uses the pinned Claude ACP adapter's SDK options; the SDK emits `--effort=<level>` for the underlying Claude CLI. The launch model and effort are sent together. Dispatch strips ambient `CLAUDE_EFFORT` and `CLAUDE_CODE_EFFORT_LEVEL` from the host environment. With a cleared global default and no explicit setting, it supplies neither an effort flag nor either environment variable, leaving CLI settings in control.

Codex accepts `low`, `medium`, `high`, and `xhigh` and maps them to the ACP `reasoning_effort` option after model selection. `max` is rejected at save/launch. If the selected model or installed adapter lacks the requested option, launch fails with a descriptive error before the first prompt. A global `max` therefore requires a supported Codex override or a changed default.

OpenCode rejects explicitly configured effort. It ignores the app default so existing OpenCode launches remain usable; its settings stay in control.

## Storage and limitations

Nullable schema columns are added to templates, jobs, and agents; existing records need no data rewrite. Saved null means inherit for templates/jobs and means CLI settings for resolved agent records. The global default is an app setting, not server environment configuration.

Usage-aware `effortPolicy` (R8) is not included. Live model support still depends on the installed CLI/provider. Automated tests cover SDK argv generation, environment removal, persistence, precedence and Codex option application. A live Claude session's self-report of repository `effortLevel` remains a separate acceptance check when an authenticated Claude CLI is available.
