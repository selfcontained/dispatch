import path from "node:path";

import {
  createAgentMcpToken,
  createJobMcpToken,
  createReleaseUpdateToken,
} from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { buildCursorDispatchToolGuidance } from "../../shared/mcp/cursor-dispatch-guidance.js";
import type { AgentPin, AgentRole, AgentType } from "../types.js";
import { dispatchMcpUrl } from "./mcp-url.js";
import { shellEscape } from "./quoting.js";
import { agentIdFromSessionName } from "./session-name.js";

const CLI_BY_AGENT_TYPE: Record<
  Exclude<AgentType, "terminal">,
  keyof Pick<AppConfig, "codexBin" | "claudeBin" | "opencodeBin" | "cursorBin">
> = {
  codex: "codexBin",
  claude: "claudeBin",
  opencode: "opencodeBin",
  cursor: "cursorBin",
};

const DISPATCH_API_URL_ENV = "DISPATCH_API_URL";
const DISPATCH_RELEASE_UPDATE_TOKEN_ENV = "DISPATCH_RELEASE_UPDATE_TOKEN";

/**
 * Pull a `--append-system-prompt <value>` pair out of an arg list (codex /
 * opencode put system prompts in their own flag). Claude doesn't need this
 * normalization because its CLI accepts the flag directly.
 */
export function normalizeAgentArgsForType(
  type: AgentType,
  args: string[]
): { passthroughArgs: string[]; appendedSystemPrompt: string | null } {
  if (type === "claude") {
    return { passthroughArgs: args, appendedSystemPrompt: null };
  }

  const passthroughArgs: string[] = [];
  let appendedSystemPrompt: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "--append-system-prompt" &&
      typeof args[index + 1] === "string"
    ) {
      appendedSystemPrompt = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    passthroughArgs.push(arg);
  }

  return { passthroughArgs, appendedSystemPrompt };
}

/**
 * Compose the first user-message-style prompt handed to the agent on
 * launch — formats `initialPrompt`, `initialPins`, and `initialMedia` into
 * a single string the CLI passes through as the opening turn.
 *
 * Returns `undefined` when there's nothing to attach (the caller can then
 * skip the prompt entirely).
 */
export function buildStartupPrompt(
  initialPrompt: string | undefined,
  initialPins: AgentPin[],
  initialMedia: Array<{
    fileName: string;
    displayName: string;
    source: string;
    description: string | null;
  }>
): string | undefined {
  const trimmedPrompt = initialPrompt?.trim() || "";
  if (initialPins.length === 0 && initialMedia.length === 0) {
    return trimmedPrompt || undefined;
  }

  const sections = [
    "Startup context is attached to this session.",
    "Inspect the provided pins and shared media before acting. Use Dispatch shared-media tools to access attached files; do not try to locate them by searching the filesystem by name.",
  ];

  if (trimmedPrompt) {
    sections.push(`Instructions:\n${trimmedPrompt}`);
  }

  if (initialPins.length > 0) {
    sections.push(
      [
        "Links:",
        ...initialPins.map((pin) => {
          try {
            const hostname =
              new URL(pin.value).hostname.replace(/^www\./, "") || "Link";
            const numberedHostPattern = new RegExp(
              `^${hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\d+)?$`,
              "i"
            );
            return numberedHostPattern.test(pin.label)
              ? `- ${pin.value}`
              : `- ${pin.label}: ${pin.value}`;
          } catch {
            return `- ${pin.value}`;
          }
        }),
      ].join("\n")
    );
  }

  if (initialMedia.length > 0) {
    sections.push(
      [
        "Attached files:",
        ...initialMedia.map((file) => {
          const detail = file.description?.trim();
          const suffix = detail ? ` — ${detail}` : "";
          return `- ${file.displayName}${suffix} (available via dispatch shared media)`;
        }),
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

/**
 * Build the numbered launch guidance text shared by all CLI agent types.
 */
export function buildLaunchGuidance(
  agentId: string,
  opts: {
    agentType?: AgentType;
    jobRunId?: string;
    suggestSessionRename?: boolean;
    autoReview?: boolean;
  }
): string {
  const { agentType, jobRunId, suggestSessionRename, autoReview } = opts;
  const rules: string[] = [];
  if (agentType === "cursor") {
    rules.push(buildCursorDispatchToolGuidance());
  }

  if (jobRunId) {
    rules.push(
      `You are running a Dispatch job run (${jobRunId}). Job agents have a dedicated MCP route — use repo tools when relevant.`
    );
    if (suggestSessionRename) {
      rules.push(
        "Name the session. Once the topic of work is clear, call dispatch_rename_session with a short name for that topic, task, or feature. The name is a stable label describing what the run is about, not a live status update."
      );
    }
    rules.push("Report status with dispatch_event to keep the UI current.");
    rules.push("Log task-level progress with job_log.");
    rules.push(
      "Call a job terminal tool when the run is complete, failed, or needs input."
    );
  } else {
    rules.push(
      "No task, no work. If the user hasn't explicitly asked for a change, fix, review, or investigation, ask what they want — don't infer a task from branch/worktree context alone."
    );
    if (suggestSessionRename) {
      rules.push(
        "Name the session. Once the topic of work is clear, call dispatch_rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
      );
    }
    rules.push(
      "Report status with dispatch_event. Types: working (making progress — includes debugging, fixing test failures, investigating errors), blocked (completely stuck with no further approach to try — NOT for errors or test failures you plan to fix next), waiting_user (need a decision or approval), done (task complete), idle (no-op, just answered a question). Emit working at turn start and when shifting phases. Emit a terminal event before your final response. Your reported status is verified against session activity and auto-corrected when it doesn't match."
    );
    rules.push(
      "Pin key info with dispatch_pin so it surfaces in the sidebar — especially values users may need to copy/paste: URLs, commands, branch names, IDs, tokens, simulator UDIDs. Types: url (dev servers, docs), port (server ports), pr (PR links), filename (key files), code (short snippets, env vars, IDs), string (status, decisions), markdown (short structured summaries). To delete a stale pin, call dispatch_list_pins then dispatch_delete_pin with its id. For longer artifacts, write a file via dispatch_share and pin a reference."
    );
    rules.push(
      "Playwright: default headless. Capture at least one screenshot per UI flow via dispatch_share. Call browser_close when done."
    );
    rules.push(
      "For pull requests, use the create_pr MCP tool — not built-in PR skills or gh CLI."
    );
    if (autoReview) {
      rules.push(
        "Autonomous Review is enabled. Before emitting done: commit and push your branch, open a draft PR via create_pr (don't override baseBranch — it defaults correctly), call list_personas, then launch 1 relevant reviewer via dispatch_launch_persona. After launch, do not poll, sleep, call list_agents, or schedule a wakeup; end the turn and let Dispatch inject the structured REVIEW SUBMITTED prompt when ready. If feedback exists, call dispatch_review_list_feedback with the supplied review ID and keep all discussion in item threads via dispatch_review_add_message. After fixing an item, ask the reviewer to verify it instead of resolving it yourself. The reviewer will resolve verified fixes or reply with further instructions. A clean zero-item approval requires no action. Don't emit done until all submitted reviews are resolved."
      );
    }
  }

  const numbered = rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
  const header = jobRunId
    ? "Dispatch job startup rules:"
    : "Dispatch startup rules:";
  return `[dispatch:${agentId}] ${header}\n${numbered}`;
}

/**
 * Build the bash invocation that launches the agent CLI inside its tmux
 * session. Returns a shell-ready string.
 *
 * Encodes the per-CLI launch quirks (claude/opencode/codex MCP wiring,
 * resume vs. new session flags, terminal-only fallback to `bash -il`).
 *
 * Reads from the host environment (not threaded through `AppConfig`):
 * - `process.env.HOME` — appended to PATH so the agent can find tools in
 *   `~/.local/bin`. Falls back gracefully when unset.
 * - `process.platform` + `process.env.DISPATCH_COPY_DISPLAY` — Linux only;
 *   forwards the X display so xclip can paste browser-clipboard images.
 * - `process.env.TLS_CA` — when TLS is enabled, sets `NODE_EXTRA_CA_CERTS`
 *   so the agent's MCP loopback connection trusts the server cert.
 *
 * These are stubbable via `vi.stubEnv` for testing.
 *
 * Security note: every interpolated value flows through `shellEscape`,
 * since this string lands directly in `tmux new-session … bash -c …`.
 */
export function buildAgentCommand(
  config: AppConfig,
  type: AgentType,
  role: AgentRole,
  args: string[],
  mediaDir: string,
  sessionName: string,
  fullAccess: boolean,
  cliSessionId?: string,
  resume?: boolean,
  jobRunId?: string,
  suggestSessionRename?: boolean,
  autoReview?: boolean,
  initialPrompt?: string,
  personalityPrompt?: string | null,
  model?: string
): string {
  const agentId = agentIdFromSessionName(sessionName);
  const launchGuidance = buildLaunchGuidance(agentId, {
    agentType: type,
    jobRunId,
    suggestSessionRename,
    autoReview,
  });

  const userLocalBin = process.env.HOME
    ? path.join(process.env.HOME, ".local/bin")
    : null;
  const launchPathEntries = [config.dispatchBinDir, userLocalBin].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  const launchPathPrefix = Array.from(new Set(launchPathEntries)).join(":");

  const envPrefixParts = [
    `DISPATCH_AGENT_ID=${shellEscape(agentId)}`,
    `DISPATCH_MEDIA_DIR=${shellEscape(mediaDir)}`,
    `DISPATCH_PORT=${shellEscape(String(config.port))}`,
    `DISPATCH_SCHEME=${config.tls ? "https" : "http"}`,
    `PATH=${shellEscape(launchPathPrefix)}:$PATH`,
    // Pin the Bash tool's cwd to the project root (worktree) after every command.
    // Prevents cwd drift back to the original repo root during long conversations.
    `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`,
  ];

  if (role === "assisted_update") {
    envPrefixParts.push(
      `${DISPATCH_API_URL_ENV}=${shellEscape(
        `${config.tls ? "https" : "http"}://127.0.0.1:${config.port}`
      )}`,
      `${DISPATCH_RELEASE_UPDATE_TOKEN_ENV}=${shellEscape(
        createReleaseUpdateToken(config.authToken, agentId)
      )}`
    );
  }

  // Forward the clipboard display to agent sessions so CLI tools can read
  // images pasted via the browser clipboard. Exported under BOTH names:
  // DISPATCH_COPY_DISPLAY (Dispatch's own var) and the standard DISPLAY — the
  // CLI's Ctrl+V image paste reads $DISPLAY, so without it a browser-clipboard
  // image lands on the Xvfb clipboard but the agent can't read it back.
  //
  // Limitation (by design): all Linux agent sessions point at the SAME Xvfb
  // display, and an X clipboard selection is global to a display. So the
  // clipboard is shared across agents — two agents pasting images concurrently
  // race for the selection, and one agent could read an image another just
  // pasted. This is acceptable because the selection is consumed immediately
  // (set → Ctrl+V → done) and path-based drag-drop is the isolation-safe route;
  // per-agent isolation would require a dedicated Xvfb per session. Exporting
  // the standard DISPLAY also means any X-aware tool the agent launches will
  // attach to this shared display, not just the intended CLI paste.
  if (process.platform === "linux" && process.env.DISPATCH_COPY_DISPLAY) {
    const copyDisplay = shellEscape(process.env.DISPATCH_COPY_DISPLAY);
    envPrefixParts.push(
      `DISPATCH_COPY_DISPLAY=${copyDisplay}`,
      `DISPLAY=${copyDisplay}`
    );
  }

  // When TLS is enabled with a CA cert, tell agent CLI tools to trust it
  // so loopback MCP connections don't fail certificate verification.
  // TLS_CA should point at the CA that signed the server cert (e.g. mkcert's rootCA.pem).
  const tlsCaPath = process.env.TLS_CA;
  if (config.tls && tlsCaPath) {
    envPrefixParts.push(`NODE_EXTRA_CA_CERTS=${shellEscape(tlsCaPath)}`);
  }

  if (type === "opencode" && fullAccess) {
    envPrefixParts.push(
      `OPENCODE_PERMISSION=${shellEscape(
        JSON.stringify({
          bash: { "*": "allow" },
          edit: { "*": "allow" },
          read: { "*": "allow" },
          list: { "*": "allow" },
          glob: { "*": "allow" },
          grep: { "*": "allow" },
          task: { "*": "allow" },
          todowrite: { "*": "allow" },
          todoread: { "*": "allow" },
          webfetch: { "*": "allow" },
          websearch: { "*": "allow" },
          codesearch: { "*": "allow" },
          lsp: { "*": "allow" },
          skill: { "*": "allow" },
          external_directory: { "*": "allow" },
        })
      )}`
    );
  }

  const envPrefix = envPrefixParts.join(" ");

  // Terminal agents have no CLI to launch — drop the user into an
  // interactive login shell in the chosen cwd/worktree. `-l` alone starts a
  // non-interactive login shell that exits immediately under `bash -c`,
  // which tears down the tmux session before the browser can attach.
  if (type === "terminal") {
    return `${envPrefix} "\${SHELL:-/bin/bash}" -il`;
  }

  const cliBin = config[CLI_BY_AGENT_TYPE[type]];
  const mcpUrl = dispatchMcpUrl(config, agentId, jobRunId);
  const dispatchMcpToken = jobRunId
    ? createJobMcpToken(config.authToken, jobRunId, agentId)
    : createAgentMcpToken(config.authToken, agentId);
  const codexDispatchAuthEnv = "DISPATCH_AUTH_TOKEN";
  const { passthroughArgs, appendedSystemPrompt } = normalizeAgentArgsForType(
    type,
    args
  );

  if (type === "claude") {
    const mcpConfig = shellEscape(
      JSON.stringify({
        mcpServers: {
          dispatch: {
            type: "http",
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${dispatchMcpToken}`,
            },
          },
        },
      })
    );
    const mcpFlag = `--mcp-config ${mcpConfig}`;
    // Elevate guidance to system prompt so it persists through long conversations
    // and isn't buried as an early user message. CLAUDE.md is also auto-loaded by
    // Claude Code and provides the full behavioral spec.
    const systemFlag = `--append-system-prompt ${shellEscape(launchGuidance)}`;
    const personalityFlag = personalityPrompt
      ? `--append-system-prompt ${shellEscape(personalityPrompt)}`
      : "";
    // Session tracking: --resume continues an existing session, --session-id starts
    // a new one with a known ID for token attribution and future resume.
    const sessionFlag = cliSessionId
      ? resume
        ? `--resume ${shellEscape(cliSessionId)}`
        : `--session-id ${shellEscape(cliSessionId)}`
      : "";
    const modelFlag = model ? `--model ${shellEscape(model)}` : "";
    const flags = [mcpFlag, systemFlag, personalityFlag, sessionFlag, modelFlag]
      .filter(Boolean)
      .join(" ");
    // initialPrompt becomes the first user message (positional arg to Claude
    // Code CLI). Separate it from options with `--` so structured Dispatch
    // blocks that begin with `---` are not parsed as unknown CLI flags.
    if (args.length === 0 && !initialPrompt) {
      return `${envPrefix} ${shellEscape(cliBin)} ${flags}`;
    }
    const commandArgs = args.map((arg) => shellEscape(arg));
    if (initialPrompt) {
      commandArgs.push("--", shellEscape(initialPrompt));
    }
    return `${envPrefix} ${shellEscape(cliBin)} ${flags} ${commandArgs.join(" ")}`;
  }

  if (type === "opencode") {
    const promptParts = [
      launchGuidance,
      appendedSystemPrompt,
      personalityPrompt || null,
      initialPrompt,
    ].filter(Boolean);
    const startupPrompt = promptParts.join("\n\n");
    const promptFlag = `--prompt ${shellEscape(startupPrompt)}`;
    const sessionFlag =
      resume && cliSessionId ? `--session ${shellEscape(cliSessionId)}` : "";
    const flagParts = [promptFlag, sessionFlag].filter(Boolean).join(" ");
    if (passthroughArgs.length === 0) {
      return `${envPrefix} ${shellEscape(cliBin)} ${flagParts}`;
    }
    const escaped = passthroughArgs.map((arg) => shellEscape(arg)).join(" ");
    return `${envPrefix} ${shellEscape(cliBin)} ${escaped} ${flagParts}`;
  }

  if (type === "cursor") {
    // MCP config is written via .cursor/mcp.json in the setup script.
    // Guidance + personality are delivered as the initial prompt (same as Codex).
    const flagParts: string[] = [];
    if (fullAccess) {
      flagParts.push("--force", "--approve-mcps");
    }
    if (resume && cliSessionId) {
      flagParts.push("--resume", shellEscape(cliSessionId));
    }
    const cursorPromptParts = [
      launchGuidance,
      appendedSystemPrompt,
      personalityPrompt || null,
      initialPrompt,
    ].filter(Boolean);
    const startupPrompt = cursorPromptParts.join("\n\n");
    if (passthroughArgs.length > 0) {
      const escaped = passthroughArgs.map((arg) => shellEscape(arg)).join(" ");
      flagParts.push(escaped);
    }
    if (model) flagParts.push("--model", shellEscape(model));
    if (startupPrompt) {
      return `${envPrefix} ${shellEscape(cliBin)} ${flagParts.join(" ")} ${shellEscape(startupPrompt)}`.trim();
    }
    const flags = flagParts.join(" ");
    return flags
      ? `${envPrefix} ${shellEscape(cliBin)} ${flags}`
      : `${envPrefix} ${shellEscape(cliBin)}`;
  }

  // Codex: positional arg — AGENTS.md is auto-loaded by Codex CLI and provides authority.
  const codexMcpFlags = [
    "-c",
    shellEscape(`mcp_servers.dispatch.url=${JSON.stringify(mcpUrl)}`),
    "-c",
    shellEscape(
      `mcp_servers.dispatch.bearer_token_env_var=${JSON.stringify(codexDispatchAuthEnv)}`
    ),
  ].join(" ");
  const codexEnvPrefix = `${envPrefix} ${codexDispatchAuthEnv}=${shellEscape(dispatchMcpToken)}`;
  const modelFlag = model ? `--model ${shellEscape(model)}` : "";
  // Codex resume: `codex resume <sessionId>` with MCP flags
  if (resume && cliSessionId) {
    return `${codexEnvPrefix} ${shellEscape(cliBin)} resume ${shellEscape(cliSessionId)} ${modelFlag} ${codexMcpFlags}`;
  }
  const codexPromptParts = [
    launchGuidance,
    appendedSystemPrompt,
    personalityPrompt || null,
    initialPrompt,
  ].filter(Boolean);
  const startupPrompt = codexPromptParts.join("\n\n");
  if (passthroughArgs.length === 0) {
    return `${codexEnvPrefix} ${shellEscape(cliBin)} ${codexMcpFlags} ${modelFlag} ${shellEscape(startupPrompt)}`;
  }
  const escaped = passthroughArgs.map((arg) => shellEscape(arg)).join(" ");
  return `${codexEnvPrefix} ${shellEscape(cliBin)} ${codexMcpFlags} ${modelFlag} ${escaped} ${shellEscape(startupPrompt)}`;
}
