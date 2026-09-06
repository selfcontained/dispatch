import path from "node:path";

import {
  createAgentMcpToken,
  createJobMcpToken,
  createReleaseUpdateToken,
} from "../../auth.js";
import { buildChatEnvelope } from "../../chat/envelope.js";
import type { AppConfig } from "../../config.js";
import { PLUGIN_AGENT_TYPES } from "../../shared/agent-types.js";
import { buildCursorDispatchToolGuidance } from "../../shared/mcp/cursor-dispatch-guidance.js";
import type { AgentPin, AgentRole, AgentType } from "../types.js";
import { commandLogPath } from "../dsh/command-log.js";
import { dispatchMcpUrl } from "./mcp-url.js";
import { shellEscape } from "./quoting.js";
import { agentIdFromSessionName } from "./session-name.js";

// Exported so other code that needs "which AppConfig field holds this agent
// type's binary" (e.g. plugin-status.ts, which shells out to claude/codex
// directly) doesn't redeclare the mapping.
export const CLI_BY_AGENT_TYPE: Record<
  Exclude<AgentType, "terminal">,
  keyof Pick<
    AppConfig,
    "codexBin" | "claudeBin" | "opencodeBin" | "cursorBin" | "dshBin"
  >
> = {
  codex: "codexBin",
  claude: "claudeBin",
  opencode: "opencodeBin",
  cursor: "cursorBin",
  dispatch: "dshBin",
};

const DISPATCH_API_URL_ENV = "DISPATCH_API_URL";
const DISPATCH_RELEASE_UPDATE_TOKEN_ENV = "DISPATCH_RELEASE_UPDATE_TOKEN";

/**
 * Agent types that can install the Dispatch plugin, whose skills carry the
 * depth the trimmed rules drop. Opencode and Cursor have no plugin at all, so
 * they keep the full guidance even when the trim setting is on — otherwise
 * they'd lose that guidance with nothing replacing it.
 */
const PLUGIN_CAPABLE_AGENT_TYPES: ReadonlySet<AgentType> = new Set(
  PLUGIN_AGENT_TYPES
);

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
  return extractAppendedSystemPrompt(args);
}

/**
 * Split a `--append-system-prompt <value>` pair out of an arg list. This is
 * how a persona launch carries its brief; the CLI branches that take the
 * prompt through their own flag call this, and so does the dsh persona
 * builder, which folds the brief into the harness's system prompt.
 */
export function extractAppendedSystemPrompt(args: string[]): {
  passthroughArgs: string[];
  appendedSystemPrompt: string | null;
} {
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

function stripModelArgs(args: string[]): string[] {
  const filtered: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model" || arg === "-m") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=") || arg.startsWith("-m")) continue;
    filtered.push(arg);
  }

  return filtered;
}

/** A startup file as `seedInitialMedia` reports it, for the first turn. */
export type StartupMedia = {
  fileName: string;
  displayName: string;
  source: string;
  description: string | null;
};

/**
 * The Chat feed's launch post, fixed before the CLI command is built so the
 * first turn can carry its id. `attachmentLines` are the recorder's own
 * envelope lines for the startup files, links and pins — one source, so the
 * pane and the post agree.
 */
export type ChatLaunchPost = {
  messageId: string;
  attachmentLines: string[];
};

export type StartupTurnInput = {
  initialPrompt?: string;
  initialPins?: AgentPin[];
  initialMedia?: StartupMedia[];
  chatLaunchPost?: ChatLaunchPost | null;
};

/**
 * The agent's first user turn. With the chat surface on and a launch post
 * recorded, the prompt is wrapped in the same `--- DISPATCH CHAT ---`
 * envelope a Chat message is injected with (id = the launch post, the
 * attachments listed the same way, the trailer pointing the agent at
 * dispatch_chat_post), so an agent started from the Chat tab knows to answer
 * there. Job runs never wrap (their prompt is a system-prompt append), and
 * with the flag off — or nothing recorded — the plain startup prompt is used.
 */
export function buildStartupTurn(
  startup: StartupTurnInput,
  opts: { chatSurface?: boolean; jobRunId?: string }
): string | undefined {
  const post = startup.chatLaunchPost;
  if (opts.chatSurface && !opts.jobRunId && post) {
    return buildChatEnvelope(
      post.messageId,
      startup.initialPrompt?.trim() ?? "",
      post.attachmentLines
    );
  }
  return buildStartupPrompt(
    startup.initialPrompt,
    startup.initialPins ?? [],
    startup.initialMedia ?? []
  );
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
  initialMedia: StartupMedia[]
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
 * The one chat-surface rule, added only when the flag is on. This is the only
 * place that tells an agent to *prefer* Chat: the tool description stays
 * capability-neutral because the tool is registered whether or not the user
 * can see the Chat tab. The description carries the kinds, question options,
 * and attachment schema.
 */
export const CHAT_SURFACE_GUIDANCE_RULE =
  "The user is reading Chat, not Console. Send every user-facing reply and question with dispatch_chat_post; use kind: question with options for finite choices.";

/**
 * Build the numbered launch guidance text shared by all CLI agent types.
 *
 * `trimmedGuidance` swaps the verbose rules for short generic ones. Two
 * different things carry the detail it drops, and the distinction matters:
 *
 * - **The MCP tool schemas.** `dispatch_pin`'s own description already lists
 *   every pin type, explains shortcut/confirm/disabled, and says to pair a
 *   blocking shortcut with `waiting_user`; `dispatch_event`'s enumerates the
 *   status types. Restating them here duplicated a description the agent
 *   already has, in every session, whether or not the flow ever comes up. The
 *   trimmed rules say *that* these tools matter and leave the *how* to the
 *   schema. This half does not depend on the plugin at all.
 * - **Plugin skills**, for the Playwright methodology (→ `ui-validation` +
 *   `sharing`) and the `create_pr` routing line (→ `review-workflow`). This
 *   half genuinely needs the plugin installed, which is why the setting is
 *   worded as an assertion about it.
 *
 * What never trims is the rule with no replacement anywhere: the no-task
 * guardrail. Nothing else states it, and it has to fire before a task exists.
 *
 * A short `dispatch_share_file` nudge survives the trim on purpose. That habit was
 * already stated in two always-on places and agents still pasted file paths
 * into chat, so it's the one tool-routing rule with a demonstrated failure
 * history — the toggle tests `create_pr`, not this.
 *
 * The Autonomous Review rule is shortened for *everyone*, toggle or not, and
 * that has nothing to do with the plugin: two thirds of the old block was
 * reactive ("after feedback arrives, do X"), and Dispatch already re-injects
 * each of those clauses at the moment they apply — see
 * `buildLaunchPersonaResponseText` and `reviews/injection-prompts.ts`. What
 * remains is the part nothing can inject: the gate the agent must already know
 * before it decides it is done, plus a pointer to
 * `dispatch_review_list_feedback` — injection is best-effort and is dropped
 * when the parent has no live session, so the agent needs one durable way to
 * find a review that was submitted while it was down.
 */
export function buildLaunchGuidance(
  agentId: string,
  opts: {
    agentType?: AgentType;
    jobRunId?: string;
    suggestSessionRename?: boolean;
    autoReview?: boolean;
    trimmedGuidance?: boolean;
    /**
     * The chat-surface flag (`chat_surface_enabled`). When on, the user is
     * reading the Chat tab, so one rule routes replies and questions through
     * dispatch_chat_post. Same text trimmed or not: the tool description
     * carries the schema.
     */
    chatSurface?: boolean;
  }
): string {
  const {
    agentType,
    jobRunId,
    suggestSessionRename,
    autoReview,
    trimmedGuidance,
    chatSurface,
  } = opts;
  const trimmed =
    trimmedGuidance === true &&
    agentType !== undefined &&
    PLUGIN_CAPABLE_AGENT_TYPES.has(agentType);
  const rules: string[] = [];
  if (agentType === "cursor") {
    rules.push(buildCursorDispatchToolGuidance());
  }

  if (jobRunId) {
    // Not affected by `trimmed`: every rule on this branch is a runtime
    // protocol obligation (status, job_log, terminal event) with no
    // task-shaped trigger a skill description could key on.
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
        trimmed
          ? "Name the session with dispatch_rename_session once the topic is clear — a short label for what the session is about, not a live status."
          : "Name the session. Once the topic of work is clear, call dispatch_rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
      );
    }
    rules.push(
      trimmed
        ? "Report status with dispatch_event as you work and before your final response — blocked means genuinely stuck, not an error you're about to fix. Your reported status is verified against session activity and auto-corrected."
        : "Report status with dispatch_event. Types: working (making progress — includes debugging, fixing test failures, investigating errors), blocked (completely stuck with no further approach to try — NOT for errors or test failures you plan to fix next), waiting_user (need a decision or approval), done (task complete), idle (no-op, just answered a question). Emit working at turn start and when shifting phases. Emit a terminal event before your final response. Your reported status is verified against session activity and auto-corrected when it doesn't match."
    );
    if (chatSurface) {
      rules.push(CHAT_SURFACE_GUIDANCE_RULE);
    }
    if (trimmed) {
      // One rule instead of two: surface values, and ask questions, with pins.
      // The tool schema carries the types, shortcut mechanics, and deletion.
      rules.push(
        "Surface important data to the user with dispatch_pin — anything they may need to read or copy — and use shortcut pins to offer a next step. Route a structured decision, form, or status view to dispatch_surface_create instead."
      );
    } else {
      rules.push(
        "Pin key info with dispatch_pin so it surfaces in the sidebar — especially values users may need to copy/paste: URLs, commands, branch names, IDs, tokens, simulator UDIDs. Types: url (dev servers, docs), port (server ports), pr (PR links), filename (key files), code (short snippets, env vars, IDs), string (status, decisions), markdown (short structured summaries), shortcut (a button that sends a prompt back to you when clicked). To delete a stale pin, call dispatch_list_pins then dispatch_delete_pin with its id. For longer artifacts, write a file via dispatch_share_file and pin a reference."
      );
      rules.push(
        "Offer a shortcut pin when you can name the user's likely next move (launch this, re-run that, confirm a single choice). Set confirm on destructive ones, and emit waiting_user alongside when the pin answers something blocking you. For a structured decision, form, or status view — several related values, or something the user must fill in — use dispatch_surface_create instead of a shortcut pin."
      );
    }
    rules.push(
      trimmed
        ? "Share artifacts with dispatch_share_file — screenshots, logs, reports. A file path pasted into chat is not a deliverable."
        : "Playwright: default headless. Capture at least one screenshot per UI flow via dispatch_share_file. Call browser_close when done."
    );
    if (!trimmed) {
      rules.push(
        "For pull requests, use the create_pr MCP tool — not built-in PR skills or gh CLI."
      );
    }
    if (autoReview) {
      rules.push(
        "Autonomous Review is enabled. Before emitting done: commit and push your branch, open a draft PR via create_pr (don't override baseBranch — it defaults correctly), call list_personas, then launch relevant reviewers via dispatch_launch_persona. Dispatch will guide the rest as it happens. Don't emit done until all submitted reviews are resolved — if a review prompt never arrived, check with dispatch_review_list_feedback."
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
type BuildAgentCommandOptions = {
  cliSessionId?: string;
  resume?: boolean;
  jobRunId?: string;
  suggestSessionRename?: boolean;
  autoReview?: boolean;
  trimmedGuidance?: boolean;
  chatSurface?: boolean;
  /**
   * Raw first-turn inputs; `buildStartupTurn` composes them (envelope or
   * plain startup prompt) using `chatSurface` and `jobRunId`.
   */
  initialPrompt?: string;
  initialPins?: AgentPin[];
  initialMedia?: StartupMedia[];
  chatLaunchPost?: ChatLaunchPost | null;
  personalityPrompt?: string | null;
  model?: string;
};

export function buildAgentCommand(
  config: AppConfig,
  type: AgentType,
  role: AgentRole,
  args: string[],
  mediaDir: string,
  sessionName: string,
  fullAccess: boolean,
  {
    cliSessionId,
    resume,
    jobRunId,
    suggestSessionRename,
    autoReview,
    trimmedGuidance,
    chatSurface,
    initialPrompt: rawInitialPrompt,
    initialPins,
    initialMedia,
    chatLaunchPost,
    personalityPrompt,
    model,
  }: BuildAgentCommandOptions = {}
): string {
  const agentId = agentIdFromSessionName(sessionName);
  const initialPrompt = buildStartupTurn(
    {
      initialPrompt: rawInitialPrompt,
      initialPins,
      initialMedia,
      chatLaunchPost,
    },
    { chatSurface, jobRunId }
  );
  const launchGuidance = buildLaunchGuidance(agentId, {
    agentType: type,
    jobRunId,
    suggestSessionRename,
    autoReview,
    trimmedGuidance,
    chatSurface,
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
  // dsh agents also get a plain shell in the pane: the ACP driver
  // (agents/dsh) owns the harness process, and the pane is the human's
  // console into the worktree.
  if (type === "terminal") {
    return `${envPrefix} "\${SHELL:-/bin/bash}" -il`;
  }
  if (type === "dispatch") {
    // The harness runs its commands in its own process; the pane shows
    // their log (agents/dsh/command-log.ts) in a split above an
    // interactive shell, so the Console reads as the agent's terminal.
    const log = shellEscape(commandLogPath(config.dshHome, agentId));
    const logDir = shellEscape(
      path.dirname(commandLogPath(config.dshHome, agentId))
    );
    return [
      `${envPrefix} mkdir -p ${logDir} && touch ${log} &&`,
      `tmux split-window -d -v -l 60% -b -t "$TMUX_PANE" -c "$PWD" "tail -n 300 -F ${log}";`,
      `exec "\${SHELL:-/bin/bash}" -il`,
    ].join(" ");
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
  const launchArgs = model ? stripModelArgs(passthroughArgs) : passthroughArgs;

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
    if (launchArgs.length === 0 && !initialPrompt) {
      return `${envPrefix} ${shellEscape(cliBin)} ${flags}`;
    }
    const commandArgs = launchArgs.map((arg) => shellEscape(arg));
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
    if (model) flagParts.push("--model", shellEscape(model));
    if (launchArgs.length > 0) {
      const escaped = launchArgs.map((arg) => shellEscape(arg)).join(" ");
      flagParts.push(escaped);
    }
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
  // Codex resume: `codex resume [OPTIONS] <SESSION_ID>`. Options go before the
  // session id so it always binds to SESSION_ID and never slides into the
  // trailing [PROMPT] positional. Passthrough args are re-applied here too —
  // they carry `--dangerously-bypass-approvals-and-sandbox` for full-access
  // agents, which a resumed session would otherwise silently lose.
  if (resume && cliSessionId) {
    const resumeFlags = [
      codexMcpFlags,
      modelFlag,
      ...launchArgs.map((arg) => shellEscape(arg)),
    ]
      .filter(Boolean)
      .join(" ");
    return `${codexEnvPrefix} ${shellEscape(cliBin)} resume ${resumeFlags} ${shellEscape(cliSessionId)}`;
  }
  const codexPromptParts = [
    launchGuidance,
    appendedSystemPrompt,
    personalityPrompt || null,
    initialPrompt,
  ].filter(Boolean);
  const startupPrompt = codexPromptParts.join("\n\n");
  if (launchArgs.length === 0) {
    return `${codexEnvPrefix} ${shellEscape(cliBin)} ${codexMcpFlags} ${modelFlag} ${shellEscape(startupPrompt)}`;
  }
  const escaped = launchArgs.map((arg) => shellEscape(arg)).join(" ");
  return `${codexEnvPrefix} ${shellEscape(cliBin)} ${codexMcpFlags} ${modelFlag} ${escaped} ${shellEscape(startupPrompt)}`;
}
