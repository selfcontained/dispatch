# Plugin format reference: Claude Code and Codex

Reference material for the **external** plugin formats of Claude Code and OpenAI Codex.
This document deliberately contains **no Dispatch-specific design decisions** — it exists so a
future builder never has to reconstruct these formats mid-build. Everything here is either quoted
from current official docs (URL cited) or observed from a real CLI run (command and output shown).
Anything that could not be verified is called out explicitly in
[Unverified / open items](#unverified--open-items).

## How this was verified

|                      |                                         |
| :------------------- | :-------------------------------------- |
| Date of verification | 2026-08-13                              |
| Claude Code CLI      | `2.1.231` (`claude --version`)          |
| Codex CLI            | `codex-cli 0.147.0` (`codex --version`) |
| Platform             | macOS (darwin 25.2.0)                   |

CLI probes ran against **throwaway config roots** (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` pointed at a
scratch directory), not the machine's real `~/.claude` or `~/.codex`. Codex source citations are
against `openai/codex` `main` as of the verification date.

---

## The short version

- **The two systems are close but not interchangeable.** Same directory conventions inside a
  plugin (`skills/<name>/SKILL.md`, `.mcp.json`, `hooks/`), different manifest directory names
  (`.claude-plugin/` vs `.codex-plugin/`), different marketplace file locations and different
  marketplace schemas.
- **The compatibility is one-way.** Codex reads Claude Code's `.claude-plugin/marketplace.json` and
  `.claude-plugin/plugin.json` as a fallback. Claude Code does **not** read Codex's
  `.agents/plugins/marketplace.json`. Verified in both directions — see
  [Do the two specs converge?](#do-the-two-specs-converge).
- **Both support fully non-interactive install.** Claude Code: `claude plugin marketplace add` +
  `claude plugin install`. Codex: `codex plugin marketplace add` + `codex plugin add`, both with
  `--json`. **Codex has no `--non-interactive` flag** — that claim (from a third-party blog, noted
  in earlier scoping) is wrong; the `codex plugin *` subcommands are plain non-TUI commands and
  need no such flag.
- **Neither platform signs or sandboxes self-hosted plugins.** Both run plugin code with the
  invoking user's full local privileges.

---

# Claude Code

## Plugin directory layout

The manifest is **optional**. Without one, Claude Code auto-discovers components in their default
locations and derives the plugin name from the directory name.

```text
my-plugin/
├── .claude-plugin/           # metadata directory (optional)
│   └── plugin.json           # the plugin manifest — the ONLY file that belongs here
├── skills/                   # skills as <name>/SKILL.md directories
│   └── code-reviewer/
│       └── SKILL.md
├── commands/                 # skills as flat .md files (legacy; use skills/ for new plugins)
├── agents/                   # subagent definitions (.md)
├── workflows/                # workflow script files
├── output-styles/            # output style definitions
├── themes/                   # color theme definitions
├── monitors/monitors.json    # background monitor configurations
├── hooks/hooks.json          # hook configuration
├── bin/                      # executables added to the Bash tool's PATH while enabled
├── settings.json             # default settings (only `agent` and `subagentStatusLine` honored)
├── .mcp.json                 # MCP server definitions
└── .lsp.json                 # LSP server configurations
```

> **Common mistake, called out in the docs:** only `plugin.json` goes inside `.claude-plugin/`.
> `commands/`, `agents/`, `skills/`, `hooks/` etc. must be at the **plugin root**.

Special case: a plugin shipping exactly one skill may put `SKILL.md` at the plugin root with no
`skills/` directory and no `skills` manifest field. Claude Code v2.1.142+ loads it as a single-skill
plugin. The invocation name comes from the frontmatter `name` field — **set it**, because the
fallback is the install directory name, which for marketplace installs is a version string that
changes on every update.

Source: <https://code.claude.com/docs/en/plugins-reference> (§ Plugin directory structure, § Path
behavior rules), <https://code.claude.com/docs/en/plugins>

## `plugin.json` schema

Location: `<plugin-root>/.claude-plugin/plugin.json`. Complete schema, quoted from the docs:

```json
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "metadata": { "catalogId": "cat-123", "tier": "pro" },
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

**Required:** `name` only (and only if you include a manifest at all). Kebab-case, no spaces. Used
for namespacing — a plugin named `plugin-dev` exposes its `agent-creator` agent as
`plugin-dev:agent-creator` and its skills as `/plugin-dev:skill-name`.

**Metadata fields** (all optional):

| Field                                 | Type    | Notes                                                                                                                         |
| :------------------------------------ | :------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `$schema`                             | string  | `https://json.schemastore.org/claude-code-plugin-manifest.json`. Ignored at load time.                                        |
| `displayName`                         | string  | UI-only. Requires v2.1.143+.                                                                                                  |
| `version`                             | string  | Semver. Setting it **pins** the plugin: users get updates only when you bump it. Wins over the marketplace entry's `version`. |
| `description`                         | string  |                                                                                                                               |
| `author`                              | object  | `{name, email?, url?}`                                                                                                        |
| `homepage` / `repository` / `license` | string  |                                                                                                                               |
| `keywords`                            | array   |                                                                                                                               |
| `metadata`                            | object  | Free-form; Claude Code never reads it. Requires v2.1.222+ to avoid an unrecognized-field warning.                             |
| `defaultEnabled`                      | boolean | Default `true`. `false` installs the plugin disabled. Requires v2.1.154+.                                                     |

**Component path fields:** `skills`, `commands`, `agents`, `workflows`, `hooks`, `mcpServers`,
`outputStyles`, `lspServers`, `experimental.themes`, `experimental.monitors`, `userConfig`,
`channels`, `dependencies`. Path rules:

- All paths relative to the plugin root and must start with `./` (the `skills` field also accepts
  `"."`, but only on v2.1.221+ — use `"./"` for older-version compatibility).
- `skills` **adds to** the default `skills/` scan. `commands`, `agents`, `workflows`,
  `outputStyles`, `experimental.themes`, `experimental.monitors` **replace** their default
  directory. `hooks`, `mcpServers`, `lspServers` have their own merge rules.
- Paths that traverse outside the plugin root (`../shared-utils`) do not work after installation —
  external files are not copied into the cache.

**Unrecognized top-level fields are ignored** at load time and reported as warnings by
`claude plugin validate`. A recognized field with the wrong type is usually a hard load error
(exceptions: `experimental` and `metadata`, which are ignored with a warning).

**Environment variables** available in component configs: `${CLAUDE_PLUGIN_ROOT}` (install
directory — changes on every update), `${CLAUDE_PLUGIN_DATA}`
(`~/.claude/plugins/data/{id}/`, survives updates), `${CLAUDE_PROJECT_DIR}`.

Source: <https://code.claude.com/docs/en/plugins-reference> (§ Plugin manifest schema)

## `marketplace.json` schema

Location: **`<repo-root>/.claude-plugin/marketplace.json`**.

```json
{
  "name": "company-tools",
  "owner": {
    "name": "DevTools Team",
    "email": "devtools@example.com"
  },
  "plugins": [
    {
      "name": "code-formatter",
      "source": "./plugins/formatter",
      "description": "Automatic code formatting on save",
      "version": "2.1.0",
      "author": {
        "name": "DevTools Team"
      }
    },
    {
      "name": "deployment-tools",
      "source": {
        "source": "github",
        "repo": "company/deploy-plugin"
      },
      "description": "Deployment automation tools"
    }
  ]
}
```

**Required top-level fields:** `name` (kebab-case, public-facing — users type
`plugin@marketplace-name`), `owner` (object; `name` required, `email`/`url` optional), `plugins`
(array).

**Optional top-level fields:** `$schema`, `description`, `version`, `metadata.pluginRoot` (base
directory prepended to relative plugin sources), `allowCrossMarketplaceDependenciesOn`, `renames`
(map of old plugin name → new name or `null`; requires v2.1.193+).

**Reserved marketplace names** you cannot use: `claude-code-marketplace`, `claude-code-plugins`,
`claude-plugins-official`, `claude-plugins-community`, `claude-community`, `anthropic-marketplace`,
`anthropic-plugins`, `agent-skills`, `anthropic-agent-skills`, `knowledge-work-plugins`,
`life-sciences`, `claude-for-legal`, `claude-for-financial-services`,
`financial-services-plugins`, `first-party-plugins`, `healthcare` — plus names that impersonate
official ones (e.g. `official-claude-plugins`).

**Plugin entry — required:** `name`, `source`. **Optional:** any field from the plugin manifest
schema, plus the marketplace-specific `category`, `tags`, `strict`, `relevance`, `defaultEnabled`.

**Plugin `source` types:**

| Source        | Type                         | Fields                             | Notes                                                                                                                                        |
| :------------ | :--------------------------- | :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| relative path | string, e.g. `"./my-plugin"` | —                                  | Must start with `./`; resolved against the **marketplace root** (the dir containing `.claude-plugin/`), not against `.claude-plugin/` itself |
| `github`      | object                       | `repo`, `ref?`, `sha?`             | `repo` is `owner/repo`; `sha` is a full 40-char SHA                                                                                          |
| `url`         | object                       | `url`, `ref?`, `sha?`              | Any git URL (`https://` or `git@`); `.git` suffix optional                                                                                   |
| `git-subdir`  | object                       | `url`, `path`, `ref?`, `sha?`      | Sparse partial clone, for monorepos                                                                                                          |
| `npm`         | object                       | `package`, `version?`, `registry?` |                                                                                                                                              |
| `archive`     | object                       | `url`, `sha256?`                   | HTTPS zip; works without git or npm. Requires v2.1.224+                                                                                      |

When both `ref` and `sha` are set, `sha` wins.

> **Gotcha:** relative-path sources only resolve when the user adds the marketplace from a git
> source or a local directory. If a user adds it via a direct URL to the `marketplace.json` file,
> Claude Code downloads only that one file and relative paths break. For URL-based distribution use
> `github`/`url`/`npm`/`archive` sources instead.

Source: <https://code.claude.com/docs/en/plugin-marketplaces> (§ Marketplace schema, § Plugin
sources)

## Install flow (self-hosted, no vendor submission)

Two steps: register the marketplace, then install plugins from it. No Anthropic review is involved
for a self-hosted marketplace.

**Interactive (inside a session):**

```
/plugin marketplace add owner/repo
/plugin install plugin-name@marketplace-name
```

`/plugin marketplace add` accepts: GitHub `owner/repo` shorthand (append `@ref` to pin), a full git
URL (append `#ref` to pin; `https://` prefix is **required** as of v2.1.196), a local directory
path or a direct path to a `marketplace.json`, or a remote URL serving `marketplace.json`.

**Non-interactive (shell, scriptable):**

```bash
claude plugin marketplace add <source> [--scope user|project|local] [--sparse <paths...>]
claude plugin install <plugin>[@<marketplace>] [--scope user|project|local] [--config key=value]
```

Both default to `--scope user`. `claude plugin install` is explicitly documented as the way to
"install without an interactive step". Plugins installed this way load on the next Claude Code
start, or on `/reload-plugins` in an already-open session.

**Observed** (`CLAUDE_CONFIG_DIR` pointed at a scratch dir; local-directory marketplace):

```console
$ claude plugin marketplace add /tmp/.../dual
Adding marketplace…✔ Successfully added marketplace: dual-probe (declared in user settings)

$ claude plugin install demo@dual-probe
Installing plugin "demo@dual-probe"...✔ Successfully installed plugin: demo@dual-probe (scope: user)

$ claude plugin list --json
[
  {
    "id": "demo@dual-probe",
    "version": "1.0.0",
    "scope": "user",
    "enabled": true,
    "installPath": "/tmp/.../claudehome/plugins/cache/dual-probe/demo/1.0.0",
    "installedAt": "2026-08-13T13:14:47.701Z",
    "lastUpdated": "2026-08-13T13:14:47.701Z"
  }
]
```

Resulting `$CLAUDE_CONFIG_DIR/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "dual-probe": {
      "source": {
        "source": "directory",
        "path": "/tmp/.../dual"
      }
    }
  },
  "enabledPlugins": {
    "demo@dual-probe": true
  }
}
```

Both commands exited 0 with no prompt. A team can also skip `marketplace add` entirely by
committing `extraKnownMarketplaces` + `enabledPlugins` into a project's `.claude/settings.json`.

**Other CLI commands:** `claude plugin list [--json] [--available]`, `plugin details <name>`,
`plugin update <plugin>`, `plugin enable|disable <plugin>`, `plugin uninstall <plugin>`,
`plugin marketplace list|remove|update`, `plugin validate <path> [--strict]`,
`plugin init <name>`, `plugin tag [path]`.

Source: <https://code.claude.com/docs/en/discover-plugins>,
<https://code.claude.com/docs/en/plugin-marketplaces> (§ Manage marketplaces from the CLI),
<https://code.claude.com/docs/en/plugins-reference> (§ CLI commands reference)

## Versioning and updates

Claude Code uses the plugin's resolved version as the **cache key** that decides whether an update
is available. Resolution order — first one set wins:

1. `version` in the plugin's `plugin.json`
2. `version` in the plugin's marketplace entry
3. The git commit SHA of the plugin's source (for `github`, `url`, `git-subdir`, and relative-path
   sources in a git-hosted marketplace)
4. The SHA-256 digest, for `archive` sources (first 12 chars)
5. `unknown`, for `npm` sources or local directories not in a git repo

| Approach           | How                              | Update behavior                                                                                                                                |
| :----------------- | :------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit version   | set `"version"` in `plugin.json` | Users update **only** when you bump it. Pushing commits without bumping does nothing; `/plugin update` reports "already at the latest version" |
| Commit-SHA version | omit `version` in both places    | Users update whenever the source commit changes                                                                                                |
| Digest version     | `archive` source, omit `version` | Updates on `sha256` pin change, or on any byte change if unpinned                                                                              |

Plugins are copied into `~/.claude/plugins/cache`, one directory per resolved version. Superseded
versions are marked orphaned and swept ~14 days later.

**Auto-update:** Claude Code refreshes marketplaces and installed plugins in the background after
session start (random delay up to 10 minutes); the running session keeps the versions it launched
with, and prompts for `/reload-plugins`. **Official Anthropic marketplaces have auto-update on by
default; third-party and local marketplaces have it off by default** — users must toggle it per
marketplace in `/plugin` → Marketplaces, or an admin sets `"autoUpdate": true` on the
`extraKnownMarketplaces` entry. Users refresh manually with `/plugin marketplace update <name>`.

Source: <https://code.claude.com/docs/en/plugins-reference> (§ Version management, § Plugin
caching), <https://code.claude.com/docs/en/discover-plugins> (§ Configure auto-updates)

## Trust and signing model

Quoted verbatim from the docs:

> Plugins and marketplaces are highly trusted components that can execute arbitrary code on your
> machine with your user privileges. Only install plugins and add marketplaces from sources you
> trust. Organizations can restrict which marketplaces users are allowed to add using managed
> marketplace restrictions.

And on install:

> Make sure you trust a plugin before installing it. Anthropic doesn't control what MCP servers,
> files, or other software are included in plugins and can't verify that they work as intended.

There is **no signing mechanism** for self-hosted plugins and **no sandbox**. The only integrity
controls available to a publisher are the optional `sha` pin (git sources) and `sha256` pin
(archive sources) in the marketplace entry, and the only org-level control is managed-settings
marketplace allowlisting (`strictKnownMarketplaces`, `blockedMarketplaces`).

Source: <https://code.claude.com/docs/en/discover-plugins> (§ Security)

## Version requirements worth knowing

Base plugin + marketplace support is present well before the tested version. Individually
version-gated behaviors documented as of 2026-08-13:

| Feature                                                  | Minimum                    |
| :------------------------------------------------------- | :------------------------- |
| Root-level `SKILL.md` auto-loaded as single-skill plugin | v2.1.142                   |
| `displayName` in manifest / marketplace entry            | v2.1.143                   |
| `defaultEnabled`                                         | v2.1.154                   |
| `renames` in `marketplace.json`                          | v2.1.193                   |
| `/plugin enable`/`disable` accepting either name form    | v2.1.195                   |
| URL scheme required in `marketplace add` (`https://`)    | v2.1.196 (behavior change) |
| `${user_config.*}` rejected in shell-form fields         | v2.1.207 (behavior change) |
| `"skills": "."` accepted                                 | v2.1.221                   |
| Install activates in the current session                 | v2.1.221                   |
| `metadata` recognized (no warning)                       | v2.1.222                   |
| `archive` plugin source                                  | v2.1.224                   |

---

# Codex

## Stability and when it shipped

**Verified:** the `codex plugin` CLI first shipped in **Codex CLI v0.131.0** (release tag
`rust-v0.131.0`, published 2026-05-18). The implementing PR is
[openai/codex#21396](https://github.com/openai/codex/pull/21396) ("add plugin marketplace CLI
commands", merged 2026-05-14).

Verification method — the CLI source file is absent at the prior release and present at v0.131.0:

```console
$ for t in rust-v0.129.0 rust-v0.130.0 rust-v0.131.0 rust-v0.132.0; do
    printf "%s: " "$t"
    gh api "repos/openai/codex/contents/codex-rs/cli/src/plugin_cmd.rs?ref=$t" -q '.size' || echo absent
  done
rust-v0.129.0: absent
rust-v0.130.0: absent
rust-v0.131.0: 12806
rust-v0.132.0: 12806
```

`--json` output on the plugin subcommands is **newer than the commands themselves** — absent at
v0.131.0 and v0.134.0, present by v0.137.0. If a script needs `--json`, require **Codex ≥ 0.137**.

The plugin system is **not behind a feature flag**: `codex plugin *` worked with no `--enable`
override on 0.147.0. OpenAI's docs do not label it beta or experimental, but note the surface is
still moving fast (roughly 16 minor releases between first ship and the tested 0.147.0), and the
`.claude-plugin` fallback described below is **undocumented** — see
[Unverified / open items](#unverified--open-items).

## Plugin directory layout

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json        # required manifest — the ONLY file that belongs here
├── skills/                # optional; scanned by default when the manifest omits `skills`
│   └── greet/
│       └── SKILL.md
├── hooks/                 # optional lifecycle hooks
├── assets/                # optional visual assets
├── .mcp.json              # optional bundled MCP servers
└── .app.json              # optional registered MCP server connections
```

> Per the docs: "Only `plugin.json` belongs in `.codex-plugin/`. Keep `skills/`, `hooks/`,
> `assets/`, `.mcp.json`, and `.app.json` at the plugin root."

**Manifest discovery order** (from `openai/codex` source, `codex-rs/exec-server-protocol/src/protocol.rs`
and `codex-rs/utils/plugins/src/plugin_namespace.rs`):

1. `<root>/plugin.json` — **only** if its `$schema` is an `https://agent-plugins.org/schemas/…`
   URI (the Agent Plugins v1 spec). Supported URI:
   `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
2. `<root>/.codex-plugin/plugin.json`
3. `<root>/.claude-plugin/plugin.json`
4. `<root>/.cursor-plugin/plugin.json`

```rust
pub const DISCOVERABLE_PLUGIN_MANIFEST_PATHS: &[&str] = &[
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
];
```

When the root `plugin.json` (Agent Plugins format) is used, `.codex-plugin/plugin.json` is read as
an **overlay** on top of it.

**Skill discovery:** if the manifest sets no `skills` path, Codex falls back to `<root>/skills/` if
that directory exists (`default_skill_roots` in `codex-rs/core-plugins/src/loader.rs`). For the
non-Agent-Plugins ("Legacy") manifest formats it also picks up a migrated `commands/` root. So a
Claude-style plugin with `skills/` and no `skills` manifest field works unchanged.

Source: <https://developers.openai.com/codex/plugins/build>;
<https://github.com/openai/codex> (`codex-rs/exec-server-protocol/src/protocol.rs`,
`codex-rs/utils/plugins/src/plugin_namespace.rs`, `codex-rs/core-plugins/src/loader.rs`)

## `plugin.json` schema

**Required:** `name` (kebab-case), `version` (semver), `description`.

**Optional package metadata:** `author` (object: `name`, `email`, `url`), `homepage`,
`repository`, `license`, `keywords`, `skills` (path, e.g. `"./skills/"`), `mcpServers` (path, e.g.
`"./.mcp.json"`), `apps` (path, e.g. `"./.app.json"`), `hooks` (path or array of paths).

**Optional `interface` block** (drives presentation in ChatGPT/Codex UI):

```json
{
  "interface": {
    "displayName": "string",
    "shortDescription": "string",
    "longDescription": "string",
    "developerName": "string",
    "category": "string",
    "capabilities": ["array of strings"],
    "websiteURL": "string",
    "privacyPolicyURL": "string",
    "termsOfServiceURL": "string",
    "defaultPrompt": ["array of strings"],
    "brandColor": "string (hex)",
    "composerIcon": "path",
    "logo": "path",
    "screenshots": ["array of paths"]
  }
}
```

**Path rule:** "Keep manifest paths relative to the plugin root and start them with `./`." All
component and asset paths must stay inside the plugin root.

Minimal working example (docs):

```json
{
  "name": "my-first-plugin",
  "version": "1.0.0",
  "description": "Reusable greeting workflow",
  "skills": "./skills/"
}
```

Source: <https://developers.openai.com/codex/plugins/build>

## `marketplace.json` schema and location

**Discovery order** (`codex-rs/core-plugins/src/marketplace.rs`, `MARKETPLACE_MANIFEST_RELATIVE_PATHS`):

```rust
const MARKETPLACE_MANIFEST_RELATIVE_PATHS: &[&str] = &[
    ".agents/plugins/marketplace.json",
    ".agents/plugins/api_marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
];
```

The docs name `$REPO_ROOT/.agents/plugins/marketplace.json` for a repo-scoped catalog and
`~/.agents/plugins/marketplace.json` for a personal one. The `.claude-plugin` and `.cursor-plugin`
entries are real (see the verified probe below) but not documented.

**Native Codex schema:**

```json
{
  "name": "string (marketplace identifier)",
  "interface": {
    "displayName": "string (shown in ChatGPT)"
  },
  "plugins": [
    {
      "name": "string",
      "source": {
        "source": "local",
        "path": "./relative/path"
      },
      "policy": {
        "installation": "AVAILABLE|INSTALLED_BY_DEFAULT|NOT_AVAILABLE",
        "authentication": "ON_INSTALL|ON_FIRST_USE"
      },
      "category": "string"
    }
  ]
}
```

Alternative `source` shapes:

```json
{
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/...",
    "path": "./plugins/name",
    "ref": "main"
  }
}
```

```json
{
  "source": {
    "source": "npm",
    "package": "@scope/name",
    "version": "^1.0.0",
    "registry": "https://registry.npmjs.org"
  }
}
```

**Verified — only the listed locations work.** A directory with `marketplace.json` at the root, or
at `.codex-plugin/marketplace.json`, is rejected:

```console
$ codex plugin marketplace add ./alt1   # has .codex-plugin/marketplace.json
Error: invalid marketplace file `…/alt1`: marketplace root does not contain a supported manifest

$ codex plugin marketplace add ./alt2   # has ./marketplace.json at the root
Error: invalid marketplace file `…/alt2`: marketplace root does not contain a supported manifest
```

Source: <https://developers.openai.com/codex/plugins/build>;
<https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/marketplace.rs>

## Install flow (self-hosted, no vendor submission)

```bash
codex plugin marketplace add <SOURCE> [--ref <REF>] [--sparse <PATH>]... [--json]
codex plugin add <PLUGIN>[@<MARKETPLACE>] [--marketplace <NAME>] [--json]
```

`<SOURCE>` accepts, per `codex plugin marketplace add --help`: "a local path, `owner/repo[@ref]`,
HTTPS Git URL, or SSH Git URL". Documented examples:

```bash
codex plugin marketplace add ./path/to/marketplace
codex plugin marketplace add owner/repo --ref main
codex plugin marketplace add https://github.com/owner/repo --sparse plugins/foo
```

The install target is `PLUGIN@MARKETPLACE` or `PLUGIN --marketplace MARKETPLACE`. Per PR #21396,
a marketplace must be **explicitly configured** before its plugins are installable — a repo-local
`marketplace.json` sitting in the cwd is not an install source, and a cached plugin artifact alone
never makes a plugin installable.

**Observed end-to-end** (`CODEX_HOME` pointed at a scratch dir; local-directory marketplace):

```console
$ codex plugin marketplace add /tmp/.../mkt --json
{
  "marketplaceName": "spec-probe",
  "installedRoot": "/tmp/.../mkt",
  "alreadyAdded": false
}

$ codex plugin add hello@spec-probe --json
{
  "pluginId": "hello@spec-probe",
  "name": "hello",
  "marketplaceName": "spec-probe",
  "version": "1.0.0",
  "installedPath": "/tmp/.../home/plugins/cache/spec-probe/hello/1.0.0",
  "authPolicy": "ON_INSTALL"
}
```

Both exited 0 with no prompt. Resulting `$CODEX_HOME/config.toml`:

```toml
[marketplaces.spec-probe]
last_updated = "2026-08-13T13:09:44Z"
source_type = "local"
source = "/tmp/.../mkt"

[plugins."hello@spec-probe"]
enabled = true
```

Plugin bytes land in `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/`.

**Interactive equivalent:** `/plugins` inside a Codex CLI session opens the plugin browser.
A plugin can be kept installed but turned off by setting `enabled = false` on its
`[plugins."<id>"]` entry in `config.toml`.

### Non-interactive install: resolved

The `--non-interactive` flag claimed by a third-party blog **does not exist**. Full option set for
`codex plugin add` on 0.147.0:

```
Options:
  -c, --config <key=value>          Override a configuration value…
  -m, --marketplace <MARKETPLACE>   Configured marketplace name to use when PLUGIN does not include @MARKETPLACE
      --json                        Output install result as JSON
      --enable <FEATURE>            Enable a feature (repeatable)
      --disable <FEATURE>           Disable a feature (repeatable)
  -h, --help                        Print help
```

No such flag exists anywhere in the plugin CLI source either. It isn't needed: `codex plugin *` are
plain non-TUI subcommands that already run unattended. `--json` is available on `plugin add`,
`plugin list` (plus `--available`), `plugin remove`, and every `plugin marketplace` subcommand.

One caveat: a marketplace entry can declare `"authentication": "ON_INSTALL"`, and plugins bundling
connectors require a separate sign-in. An unauthenticated plugin (skills only) installs with no
interaction, as verified above; a connector-bearing plugin under `ON_INSTALL` was **not** tested.

## Versioning and updates

- `version` in `plugin.json` is **required** and should be semver. It is the cache-directory key:
  installs land in `plugins/cache/<marketplace>/<plugin>/<version>/`.
- `codex plugin marketplace upgrade [MARKETPLACE_NAME] [--json]` refreshes configured **Git**
  marketplace snapshots; omit the name to refresh all. Local-path marketplaces are **skipped** —
  observed on a local marketplace, `upgrade` returned
  `{"selectedMarketplaces":[],"upgradedRoots":[],"errors":[]}`.
- After refreshing the marketplace snapshot, re-run `codex plugin add <plugin>@<marketplace>` to
  install a newer version.
- Codex also runs a marketplace auto-upgrade at startup for Git marketplaces
  (`codex-rs/core-plugins/src/marketplace_upgrade.rs`).

Bumping `version` in `plugin.json` plus pushing to the marketplace's git ref is the mechanism for
shipping an update. **Not verified:** whether a version bump alone is sufficient to make an
already-installed plugin update without an explicit `codex plugin add` re-run.

## Trust and signing model

Codex's plugin docs state only: _"Review and trust plugin hooks before you enable them."_ There is
no documented signing or sandboxing for self-hosted plugins. Structurally, the model matches Claude
Code's: plugin hooks are commands run at lifecycle points and bundled MCP servers are local
subprocesses, both executing with the invoking user's privileges. OpenAI's published review
requirements apply to plugins submitted for distribution through OpenAI's own channels, not to a
self-hosted marketplace you add yourself.

**Treat self-hosted Codex plugins as unsigned code running with full local user privileges.**
The strongest structural claim available from official docs is the hooks-trust line above — the
rest is inference from the architecture, so flag it as such rather than quoting it as policy.

There _is_ an org-level restriction mechanism (`restrict_to_allowed_sources` +
`allowed_sources` in config requirements, `codex-rs/core-plugins/src/marketplace_policy.rs`),
analogous to Claude Code's managed marketplace restrictions.

Source: <https://learn.chatgpt.com/docs/plugins> (the canonical target of
`developers.openai.com/codex/plugins`)

---

# Do the two specs converge?

**Partly, and asymmetrically.** Verified in both directions on the installed CLIs.

## Codex reads Claude Code's format

A repository containing **only** Claude Code artifacts — `.claude-plugin/marketplace.json` with
`owner`, a string relative `source`, and a plugin whose only manifest is
`.claude-plugin/plugin.json` — installs cleanly under Codex:

```console
$ codex plugin marketplace add /tmp/.../claudeonly --json
{ "marketplaceName": "claude-only-probe", "installedRoot": "/tmp/.../claudeonly", "alreadyAdded": false }

$ codex plugin add conly@claude-only-probe --json
{
  "pluginId": "conly@claude-only-probe",
  "name": "conly",
  "marketplaceName": "claude-only-probe",
  "version": "1.0.0",
  "installedPath": "/tmp/.../home3/plugins/cache/claude-only-probe/conly/1.0.0",
  "authPolicy": "ON_INSTALL"
}
```

The cached copy contains `.claude-plugin/plugin.json` and `skills/greet/SKILL.md`.

## Claude Code does not read Codex's format

The reverse fails at both levels:

```console
$ claude plugin marketplace add /tmp/.../mkt      # only .agents/plugins/marketplace.json
✘ Failed to add marketplace: Marketplace file not found at …/mkt/.claude-plugin/marketplace.json

$ claude plugin validate /tmp/.../mkt/plugins/hello   # only .codex-plugin/plugin.json
✘ Found 1 error:
  ❯ directory: No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json
```

## What that means for a single repo

Two viable shapes:

**A. Claude-format only.** One `.claude-plugin/marketplace.json`, one
`.claude-plugin/plugin.json` per plugin, shared `skills/`. Both CLIs install from it today.
Cheapest to maintain, but it leans on the undocumented Codex `.claude-plugin` fallback and gives up
Codex-native fields (`interface`, `policy`, `apps`).

**B. Dual manifests, one tree.** Both marketplace files at the repo root and both plugin manifests
per plugin, sharing everything else. **Verified working end-to-end:**

```text
repo/
├── .claude-plugin/marketplace.json      # Claude Code schema (owner, string source)
├── .agents/plugins/marketplace.json     # Codex schema (interface, {source:"local",path}, policy)
└── plugins/demo/
    ├── .claude-plugin/plugin.json
    ├── .codex-plugin/plugin.json        # needs `version`; `skills: "./skills/"` optional
    └── skills/greet/SKILL.md            # shared by both
```

```console
$ claude plugin validate ./repo
✔ Validation passed with warnings

$ codex plugin marketplace add ./repo --json && codex plugin add demo@dual-probe --json
{ "marketplaceName": "dual-probe", … }
{ "pluginId": "demo@dual-probe", "version": "1.0.0", … }

$ claude plugin marketplace add ./repo && claude plugin install demo@dual-probe
✔ Successfully added marketplace: dual-probe (declared in user settings)
✔ Successfully installed plugin: demo@dual-probe (scope: user)
```

Codex's cache copy retained both `.claude-plugin/` and `.codex-plugin/`, so the extra manifest
directory is inert on the platform that ignores it. Keep the marketplace `name` identical in both
files so the install identifier is the same on both platforms.

## Field-level differences that bite

|                             | Claude Code                                      | Codex                                                             |
| :-------------------------- | :----------------------------------------------- | :---------------------------------------------------------------- |
| Marketplace file            | `.claude-plugin/marketplace.json`                | `.agents/plugins/marketplace.json` (also reads `.claude-plugin/`) |
| Marketplace required fields | `name`, `owner`, `plugins`                       | `name`, `plugins` (no `owner`; has `interface`)                   |
| Plugin `source` (local)     | string `"./plugins/x"`                           | object `{"source":"local","path":"./plugins/x"}`                  |
| Plugin manifest dir         | `.claude-plugin/plugin.json`                     | `.codex-plugin/plugin.json` (also reads `.claude-plugin/`)        |
| Manifest required fields    | `name` only; whole manifest optional             | `name`, `version`, `description`                                  |
| Default skills scan         | `skills/` always scanned (`skills` field _adds_) | `skills/` scanned only when the manifest omits `skills`           |
| Per-plugin install policy   | `defaultEnabled`                                 | `policy.installation` / `policy.authentication`                   |
| Install command             | `claude plugin install x@mkt`                    | `codex plugin add x@mkt`                                          |
| JSON output on install      | no (`plugin list --json` only)                   | `--json` on every plugin subcommand (≥ 0.137)                     |
| Refresh catalog             | `claude plugin marketplace update [name]`        | `codex plugin marketplace upgrade [name]` (Git only)              |

---

# Unverified / open items

Flagged explicitly so nothing here gets treated as established:

1. **Codex's `.claude-plugin` fallback is undocumented.** It is real — confirmed by CLI behavior on
   0.147.0 and by the source constants — but it appears in no OpenAI doc page found. It is an
   implementation detail that could change. A repo relying on it for Codex support has no
   documented guarantee.
2. **Codex plugin update semantics.** Whether bumping `version` in `plugin.json` alone causes an
   already-installed plugin to update (vs. requiring a re-run of `codex plugin add`) was not
   tested. Only `marketplace upgrade`'s no-op behavior on local marketplaces was observed.
3. **Codex `authentication: ON_INSTALL`.** Only a skills-only plugin with no connector was
   installed. Whether a connector-bearing plugin prompts under `ON_INSTALL` in a scripted context
   is untested.
4. **Codex git-source install.** Only local-path marketplaces were exercised end-to-end. The
   `owner/repo`, HTTPS, and SSH forms are documented in `--help` and PR #21396 but were not run
   against a live remote.
5. **Whether Codex actually surfaces the loaded skills in a session.** The install and cache
   contents were verified; a running Codex session invoking a plugin skill was not.
6. **Codex trust model wording.** The "full local user privileges, unsandboxed" characterization is
   inference from the architecture (hooks are commands, MCP servers are local subprocesses) plus
   the docs' "Review and trust plugin hooks before you enable them". Claude Code states this
   explicitly; Codex does not.
7. **Codex's Agent Plugins v1 format** (root `plugin.json` with an `agent-plugins.org` `$schema`)
   is recognized in source but was not exercised, and its full schema is at
   <https://github.com/agentplugins/agent-plugins-spec>, which was not reviewed.
8. **Claude Code minimum version for base plugin support** was not pinned down — only the
   feature-specific gates in the table above are documented. The tested CLI is v2.1.231.
9. **Third-party sources were deliberately not used as evidence.** Several `codex.danielvaughan.com`
   posts assert version numbers for Codex plugin features; none of those claims are carried here.
   Where a version number appears in this document, it comes from a `gh api` check against
   `openai/codex` release tags.

---

# Sources

**Claude Code (official docs, fetched 2026-08-13):**

- <https://code.claude.com/docs/en/plugins> — creating plugins, structure, local testing
- <https://code.claude.com/docs/en/plugins-reference> — manifest schema, directory structure, CLI
  reference, version management, caching
- <https://code.claude.com/docs/en/plugin-marketplaces> — marketplace schema, plugin sources,
  hosting, CLI marketplace commands
- <https://code.claude.com/docs/en/discover-plugins> — install flow, auto-updates, security

**Codex (official docs, fetched 2026-08-13):**

- <https://developers.openai.com/codex/plugins/build> — packaging, `plugin.json` and
  `marketplace.json` schemas
- <https://developers.openai.com/codex/plugins> → redirects to <https://learn.chatgpt.com/docs/plugins>
  — plugin concepts, surfaces, hooks-trust note

**Codex (source, `openai/codex` `main` @ 2026-08-13):**

- `codex-rs/core-plugins/src/marketplace.rs` — `MARKETPLACE_MANIFEST_RELATIVE_PATHS`
- `codex-rs/exec-server-protocol/src/protocol.rs` — `DISCOVERABLE_PLUGIN_MANIFEST_PATHS`
- `codex-rs/utils/plugins/src/plugin_namespace.rs` — `find_plugin_manifest_path`, Agent Plugins
  schema URIs
- `codex-rs/core-plugins/src/manifest.rs` — `.codex-plugin` overlay behavior
- `codex-rs/core-plugins/src/loader.rs` — `default_skill_roots`, `plugin_skill_roots`
- `codex-rs/core-plugins/src/marketplace_policy.rs` — org marketplace restrictions
- [PR #21396](https://github.com/openai/codex/pull/21396) — plugin marketplace CLI commands
- [PR #24320](https://github.com/openai/codex/pull/24320) — confirms dual `.agents` /
  `.claude-plugin` marketplace discovery

**Observed CLI behavior:** `claude` 2.1.231 and `codex-cli` 0.147.0, run against scratch
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` roots on 2026-08-13. Commands and outputs are reproduced inline
above.
