import { createAgentMcpToken, createJobMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import {
  assertSafeRefName,
  worktreePathSlug,
} from "../../shared/git/worktree.js";
import type { AgentType } from "../types.js";
import { WORKTREE_LOCAL_CONFIG_FILES } from "../worktree-local-config.js";
import { dispatchMcpUrl } from "./mcp-url.js";
import { shellEscape, shellQuote } from "./quoting.js";

export type SetupScriptParams = {
  agentId: string;
  agentType: AgentType;
  originalCwd: string;
  useWorktree: boolean;
  createNewBranch: boolean;
  worktreeBranchName?: string;
  baseBranch?: string;
  worktreePathOverride?: string;
  agentName: string;
  agentCommand: string;
  jobRunId?: string;
};

// Fully quoted, so bash interprets none of it and nothing globs.
const localConfigFileLines = WORKTREE_LOCAL_CONFIG_FILES.map((name, index) => {
  const isLast = index === WORKTREE_LOCAL_CONFIG_FILES.length - 1;
  return `      ${shellEscape(name)}${isLast ? "; do" : " \\"}`;
});

/**
 * Generate the bash setup script that runs in the agent's tmux pane on
 * launch. Pure — takes config + inputs, returns the full script as a
 * single string. The runtime (`agents/tmux/runtime.ts`) writes it to
 * disk, wraps the launch with stderr-tee + exit-capture, and execs it
 * via tmux.
 *
 * The script:
 *   1. Optionally creates a git worktree from `baseBranch`, copies the
 *      source repo's gitignored local config files into it, and
 *      installs deps.
 *   2. Phones the server back via curl at each phase boundary
 *      (`worktree`/`env`/`deps`/`session`).
 *   3. For opencode agents, writes `opencode.json` with the dispatch
 *      MCP entry before launch.
 *   4. `exec`s into `agentCommand` so the tmux pane becomes the agent.
 *
 * Stderr capture and exit-code recording are *not* handled inside the
 * script — those are runtime-owned conventions applied by the launch
 * wrapper. This keeps the script generator unconcerned with where logs
 * or exit files live.
 *
 * Security note: ref names flowing into the bash script are re-validated
 * via `assertSafeRefName` even though `createAgent` already normalizes
 * them — defense in depth, since a failure here is a bug rather than
 * user error.
 */
export function generateSetupScript(
  config: AppConfig,
  params: SetupScriptParams
): string {
  const {
    agentId,
    agentType,
    originalCwd,
    useWorktree,
    createNewBranch,
    worktreeBranchName,
    worktreePathOverride,
    agentName,
    agentCommand,
  } = params;

  const serverUrl = `${config.tls ? "https" : "http"}://127.0.0.1:${config.port}`;
  const authToken = config.authToken;

  // Helper function to call back to the server to update setup phase
  const curlPhase = (phase: string) =>
    `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/phase" ` +
    `-H "Content-Type: application/json" ` +
    `-H "Authorization: Bearer ${authToken}" ` +
    `-d '{"phase":"${phase}"}' > /dev/null 2>&1 || true`;

  // Helper to report an unrecoverable setup failure. The bash variable
  // SETUP_ERROR_MSG is interpolated as a JSON string body so the message
  // surfaces in the agent's last_error.
  const curlSetupError = (msgBashVar: string) =>
    `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/error" ` +
    `-H "Content-Type: application/json" ` +
    `-H "Authorization: Bearer ${authToken}" ` +
    `-d "{\\"message\\":\\"\${${msgBashVar}}\\"}" > /dev/null 2>&1 || true`;

  // Helper function for the completion callback
  const curlComplete = (
    cwdVar: string,
    worktreePathVar: string,
    worktreeBranchVar: string
  ) =>
    `curl -sf -X POST "${serverUrl}/api/v1/agents/${agentId}/setup/complete" ` +
    `-H "Content-Type: application/json" ` +
    `-H "Authorization: Bearer ${authToken}" ` +
    `-d "{\\"effectiveCwd\\":\\"${cwdVar}\\",\\"worktreePath\\":${worktreePathVar},\\"worktreeBranch\\":${worktreeBranchVar}}" > /dev/null 2>&1`;

  const lines: string[] = [
    `#!/usr/bin/env bash`,
    `set -euo pipefail`,
    ``,
    `# Dispatch agent setup script for ${agentName}`,
    `# This script runs in tmux so the user can see setup progress in real time.`,
    `# Stderr is captured at the launch wrapper level (the tmux runtime tees`,
    `# everything to /tmp/dispatch_setup_<id>.log), so this script doesn't`,
    `# do its own redirection.`,
    ``,
    `# Strip production credentials inherited from the parent server process.`,
    `# Placed before the user-override source so ~/.dispatch/env can still`,
    `# set DATABASE_URL deliberately when needed.`,
    `unset DATABASE_URL`,
    ``,
    `# Source user-defined overrides for agent sessions`,
    `[[ -f ~/.dispatch/env ]] && { set +e; source ~/.dispatch/env; set -euo pipefail; }`,
    ``,
    `BOLD="\\033[1m"`,
    `DIM="\\033[2m"`,
    `GREEN="\\033[32m"`,
    `YELLOW="\\033[33m"`,
    `RED="\\033[31m"`,
    `RESET="\\033[0m"`,
    ``,
    `phase() { printf "\\n\${BOLD}\${GREEN}▸ %s\${RESET}\\n" "$1"; }`,
    `info()  { printf "  \${DIM}%s\${RESET}\\n" "$1"; }`,
    `warn()  { printf "  \${YELLOW}⚠ %s\${RESET}\\n" "$1"; }`,
    `fail()  { printf "  \${RED}✗ %s\${RESET}\\n" "$1"; }`,
    `ok()    { printf "  \${GREEN}✓ %s\${RESET}\\n" "$1"; }`,
    ``,
    `EFFECTIVE_CWD="${shellQuote(originalCwd)}"`,
    `WORKTREE_PATH="null"`,
    `WORKTREE_BRANCH="null"`,
    ``,
  ];

  if (useWorktree && worktreeBranchName) {
    // Defense in depth: refs flowing through this function are interpolated
    // into a bash script that runs in tmux, so re-validate them here even
    // though createAgent already normalized them. A failure here is a bug,
    // not user error.
    assertSafeRefName(worktreeBranchName, "worktreeBranchName");
    const effectiveBaseBranch = assertSafeRefName(
      params.baseBranch || "main",
      "baseBranch"
    );

    const phaseLabel = createNewBranch
      ? "Creating git worktree"
      : "Creating managed git worktree";
    const branchLine = createNewBranch
      ? `info "Branch: ${worktreeBranchName}"`
      : `info "Checking out: ${worktreeBranchName}"`;
    lines.push(
      `# --- Worktree creation ---`,
      `phase "${phaseLabel}"`,
      branchLine,
      ``
    );

    lines.push(
      `REPO_ROOT=$(git -C "${originalCwd}" rev-parse --show-toplevel 2>/dev/null) || {`,
      `  warn "Not a git repository — skipping worktree"`,
      `  ${curlPhase("session")}`,
      `  exec_agent=true`,
      `}`,
      ``,
      `if [ "\${exec_agent:-}" != "true" ]; then`,
      `  info "Fetching origin/${effectiveBaseBranch}..."`,
      `  git -C "$REPO_ROOT" fetch origin "${effectiveBaseBranch}" --quiet 2>/dev/null || true`,
      ``,
      `  BASE_REF="origin/${effectiveBaseBranch}"`,
      `  git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF" > /dev/null 2>&1 || {`,
      `    BASE_REF="${effectiveBaseBranch}"`,
      `  }`,
      ``
    );

    if (worktreePathOverride) {
      lines.push(`  WT_PATH="${worktreePathOverride}"`);
    } else {
      // Default sibling path: <repoRoot>/../<basename>-<slug>. Use the
      // shared slug helper so the bash path matches what worktree.ts
      // computes on the inert path (and includes a hash discriminator
      // when createNewBranch=false to avoid slug collisions).
      const slugSource = createNewBranch
        ? worktreeBranchName
        : effectiveBaseBranch;
      const sluggedBranch = worktreePathSlug(slugSource, { createNewBranch });
      lines.push(
        `  REPO_BASENAME=$(basename "$REPO_ROOT")`,
        `  WT_PATH="$(dirname "$REPO_ROOT")/\${REPO_BASENAME}-${sluggedBranch}"`
      );
    }

    const addCmd = createNewBranch
      ? `git -C "$REPO_ROOT" worktree add -b "${worktreeBranchName}" "$WT_PATH" "$BASE_REF"`
      : `git -C "$REPO_ROOT" worktree add "$WT_PATH" "${effectiveBaseBranch}"`;
    const upstreamLine = createNewBranch
      ? `    git -C "$WT_PATH" branch --set-upstream-to "$BASE_REF" "${worktreeBranchName}" 2>/dev/null || true`
      : null;

    lines.push(
      ``,
      // errexit would abort on non-zero before the error handler runs (#682)
      `  set +e`,
      `  WORKTREE_ADD_OUTPUT=$(${addCmd} 2>&1)`,
      `  WT_RC=$?`,
      `  set -euo pipefail`,
      `  if [ "$WT_RC" -eq 0 ]; then`,
      `    ok "Worktree created at $WT_PATH"`,
      ...(upstreamLine ? [upstreamLine] : []),
      `    EFFECTIVE_CWD="$WT_PATH"`,
      `    WORKTREE_PATH="\\"$WT_PATH\\""`,
      `    WORKTREE_BRANCH="\\"${worktreeBranchName}\\""`,
      ``,
      `    # --- Copy local config files ---`,
      `    ${curlPhase("env")}`,
      `    phase "Copying environment files"`,
      `    SRC_ROOT=${shellEscape(originalCwd)}`,
      `    COPIED_COUNT=0`,
      // Mirrors copyLocalConfigFiles() in agents/worktree-local-config.ts.
      // The destination half is equivalent; the source half is weaker.
      // `-L` is a path test before a path-based read, so it refuses a
      // checkout that *contains* a symlink — the realistic case — but not
      // one swapped in mid-setup. Bash has no no-follow open: every read
      // primitive follows, and `cp -P` is worse, copying the link so the
      // destination escapes.
      `    copy_local_config() {`,
      `      local name="$1"`,
      `      local src="$SRC_ROOT/$name"`,
      `      local dest="$WT_PATH/$name"`,
      `      if [ -L "$src" ] || [ ! -f "$src" ]; then return 0; fi`,
      // Not load-bearing: the exclusive create settles existence. This
      // only keeps the common "repo commits this name" case quiet.
      `      if [ -e "$dest" ] || [ -L "$dest" ]; then return 0; fi`,
      // `set -C` makes the redirect O_CREAT|O_EXCL; `umask 077` matches
      // the inert path's 0600.
      `      if (umask 077; set -C; cat "$src" > "$dest") 2>/dev/null; then`,
      `        ok "Copied $name"`,
      `        COPIED_COUNT=$((COPIED_COUNT + 1))`,
      `      else`,
      `        warn "Failed to copy $name"`,
      `      fi`,
      `    }`,
      `    for LOCAL_CONFIG_NAME in \\`,
      ...localConfigFileLines,
      `      copy_local_config "$LOCAL_CONFIG_NAME"`,
      `    done`,
      `    if [ "$COPIED_COUNT" -eq 0 ]; then`,
      `      info "No local config files found — skipping"`,
      `    fi`,
      ``
    );

    if (agentType !== "terminal") {
      lines.push(
        `    # --- Install dependencies ---`,
        `    ${curlPhase("deps")}`,
        `    phase "Installing dependencies"`,
        `    cd "$WT_PATH"`,
        `    if [ -f "pnpm-lock.yaml" ]; then`,
        `      info "Detected pnpm-lock.yaml"`,
        `      pnpm install 2>&1 || warn "pnpm install failed (continuing anyway)"`,
        `      ok "Dependencies installed"`,
        `    elif [ -f "yarn.lock" ]; then`,
        `      info "Detected yarn.lock"`,
        `      yarn install 2>&1 || warn "yarn install failed (continuing anyway)"`,
        `      ok "Dependencies installed"`,
        `    elif [ -f "package-lock.json" ]; then`,
        `      info "Detected package-lock.json"`,
        `      npm install 2>&1 || warn "npm install failed (continuing anyway)"`,
        `      ok "Dependencies installed"`,
        `    elif [ -f "bun.lockb" ]; then`,
        `      info "Detected bun.lockb"`,
        `      bun install 2>&1 || warn "bun install failed (continuing anyway)"`,
        `      ok "Dependencies installed"`,
        `    else`,
        `      info "No lockfile found — skipping dependency install"`,
        `    fi`,
        ``
      );
    }

    lines.push(
      `  else`,
      // The user explicitly asked for an isolated worktree. Don't fall back
      // to running in the primary checkout — surface the failure to the
      // server (so last_error shows up in the UI) and exit. The tmux
      // session-died monitor will reconcile status to stopped.
      `    fail "Worktree creation failed"`,
      `    fail "$WORKTREE_ADD_OUTPUT"`,
      // `|| true` is load-bearing: pipeline can fail (missing iconv, severed UTF-8) and errexit would abort before the error is reported
      `    SETUP_ERROR_MSG=$(printf "%s" "\${WORKTREE_ADD_OUTPUT:0:800}" | tr -d '\\000-\\037' | iconv -f utf-8 -t utf-8 -c | sed 's/[\\\\\\"]/\\\\&/g') || true`,
      `    if [ -z "$SETUP_ERROR_MSG" ]; then SETUP_ERROR_MSG="git worktree add failed"; fi`,
      `    ${curlSetupError("SETUP_ERROR_MSG")}`,
      // Clean up partial worktree/branch so relaunch doesn't hit "already exists"
      `    git -C "$REPO_ROOT" worktree remove --force "$WT_PATH" 2>/dev/null || true`,
      ...(createNewBranch
        ? [
            `    git -C "$REPO_ROOT" branch -D "${worktreeBranchName}" 2>/dev/null || true`,
          ]
        : []),
      `    exit 1`,
      `  fi`,
      `fi`,
      ``
    );
  }

  lines.push(
    `# --- Start agent session ---`,
    `${curlPhase("session")}`,
    `phase "Starting agent session"`,
    `info "Type: ${params.agentName}"`,
    ``,
    `# Notify server that setup is complete`,
    `cd "$EFFECTIVE_CWD"`,
    `${curlComplete("$EFFECTIVE_CWD", "$WORKTREE_PATH", "$WORKTREE_BRANCH")}`,
    ``
  );

  // Opencode: write opencode.json with the Dispatch MCP server config.
  if (agentType === "opencode") {
    const mcpUrl = dispatchMcpUrl(config, agentId, params.jobRunId);
    const dispatchMcpToken = params.jobRunId
      ? createJobMcpToken(authToken, params.jobRunId, agentId)
      : createAgentMcpToken(authToken, agentId);
    const mcpEntry = JSON.stringify({
      type: "remote",
      url: mcpUrl,
      headers: { Authorization: `Bearer ${dispatchMcpToken}` },
    });
    lines.push(
      `# --- Configure opencode MCP ---`,
      `OPENCODE_CFG="$EFFECTIVE_CWD/opencode.json"`,
      `MCP_ENTRY=${shellEscape(mcpEntry)}`,
      `node --input-type=module -e 'import { readFileSync, renameSync, writeFileSync } from "node:fs"; const [configPath, mcpEntryJson] = process.argv.slice(1); const mcpEntry = JSON.parse(mcpEntryJson); let cfg = {}; try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; } cfg.mcp = { ...(cfg.mcp ?? {}), dispatch: mcpEntry }; const tmpPath = \`\${configPath}.tmp-\${process.pid}\`; writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\\n"); renameSync(tmpPath, configPath);' "$OPENCODE_CFG" "$MCP_ENTRY"`,
      `ok "Configured dispatch MCP in opencode.json"`,
      ``
    );
  }

  // Cursor: write .cursor/mcp.json (MCP server) and pre-trust the workspace.
  if (agentType === "cursor") {
    const mcpUrl = dispatchMcpUrl(config, agentId, params.jobRunId);
    const dispatchMcpToken = params.jobRunId
      ? createJobMcpToken(authToken, params.jobRunId, agentId)
      : createAgentMcpToken(authToken, agentId);
    const mcpEntry = JSON.stringify({
      type: "http",
      url: mcpUrl,
      headers: { Authorization: `Bearer ${dispatchMcpToken}` },
    });
    lines.push(
      `# --- Configure Cursor MCP ---`,
      `# Guard against symlinked .cursor directory escaping the worktree.`,
      `if [ -L "$EFFECTIVE_CWD/.cursor" ]; then`,
      `  echo "ERROR: $EFFECTIVE_CWD/.cursor is a symlink — refusing to write config outside the worktree" >&2`,
      `  exit 1`,
      `fi`,
      `mkdir -p "$EFFECTIVE_CWD/.cursor"`,
      `CURSOR_REAL=$(cd "$EFFECTIVE_CWD/.cursor" && pwd -P)`,
      `EFFECTIVE_REAL=$(cd "$EFFECTIVE_CWD" && pwd -P)`,
      `case "$CURSOR_REAL" in "$EFFECTIVE_REAL"/*) ;; *)`,
      `  echo "ERROR: .cursor resolved to $CURSOR_REAL which is outside $EFFECTIVE_REAL — refusing to write" >&2`,
      `  exit 1`,
      `esac`,
      `CURSOR_MCP_CFG="$EFFECTIVE_CWD/.cursor/mcp.json"`,
      `MCP_ENTRY=${shellEscape(mcpEntry)}`,
      `node --input-type=module -e 'import { readFileSync, renameSync, writeFileSync } from "node:fs"; const [configPath, mcpEntryJson] = process.argv.slice(1); const mcpEntry = JSON.parse(mcpEntryJson); let cfg = {}; try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; } cfg.mcpServers = { ...(cfg.mcpServers ?? {}), dispatch: mcpEntry }; const tmpPath = \`\${configPath}.tmp-\${process.pid}\`; writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\\n"); renameSync(tmpPath, configPath);' "$CURSOR_MCP_CFG" "$MCP_ENTRY"`,
      `ok "Configured dispatch MCP in .cursor/mcp.json"`,
      ``,
      `# --- Pre-trust workspace for Cursor CLI ---`,
      `# Cursor CLI prompts for workspace trust on first launch. Pre-create the`,
      `# trust marker so the prompt is skipped automatically.`,
      `CURSOR_PROJECTS_DIR="$HOME/.cursor/projects"`,
      `TRUST_SLUG=$(echo "$EFFECTIVE_CWD" | sed 's|^/||; s|/|-|g')`,
      `TRUST_DIR="$CURSOR_PROJECTS_DIR/$TRUST_SLUG"`,
      `mkdir -p "$TRUST_DIR"`,
      `printf '{"trustedAt":"%s","workspacePath":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$EFFECTIVE_CWD" > "$TRUST_DIR/.workspace-trusted"`,
      `ok "Pre-trusted workspace for Cursor CLI"`,
      ``
    );
  }

  lines.push(
    `# exec replaces this shell with the agent CLI — seamless transition.`,
    `# Exit code capture is handled by the launch wrapper, not here.`,
    `exec bash -c '${agentCommand.replaceAll("'", "'\\''")}'`
  );

  return lines.join("\n") + "\n";
}
