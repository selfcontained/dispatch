import { buildPostEnvelope } from "../chat/envelope.js";
import { PLUGIN_AGENT_TYPES } from "../shared/agent-types.js";
import type { AgentPin, AgentType } from "./types.js";

/**
 * Agent types that can install the Dispatch plugin, whose skills carry the
 * depth the trimmed rules drop.
 */
const PLUGIN_CAPABLE_AGENT_TYPES: ReadonlySet<AgentType> = new Set(
  PLUGIN_AGENT_TYPES
);

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
 * post), so an agent started from the stream knows to answer
 * there. Job runs never wrap (their prompt is a system-prompt append), and
 * with the flag off — or nothing recorded — the plain startup prompt is used.
 */
export function buildStartupTurn(
  startup: StartupTurnInput,
  opts: { chatSurface?: boolean; jobRunId?: string }
): string | undefined {
  const post = startup.chatLaunchPost;
  if (opts.chatSurface && !opts.jobRunId && post) {
    return buildPostEnvelope({
      blockId: post.messageId,
      from: { kind: "user" },
      text: startup.initialPrompt?.trim() ?? "",
      attachmentLines: post.attachmentLines,
    });
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
  "The user is reading your stream, not a console. Send every user-facing reply and question with post; use question with options for finite choices.";

/**
 * Build the numbered launch guidance text shared by all CLI agent types.
 *
 * `trimmedGuidance` swaps the verbose rules for short generic ones. Two
 * different things carry the detail it drops, and the distinction matters:
 *
 * - **The MCP tool schemas.** `pin`'s own description already lists
 *   every pin type, explains shortcut/confirm/disabled, and says to pair a
 *   blocking shortcut. Restating that here duplicated a
 *   description the agent already has, in every session, whether or not the flow ever comes up. The
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
 * A short file-posting nudge survives the trim on purpose. That habit was
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
 * `review_list_feedback` — injection is best-effort and is dropped
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
     * post. Same text trimmed or not: the tool description
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

  if (jobRunId) {
    // Not affected by `trimmed`: every rule on this branch is a runtime
    // protocol obligation (status, job_log, terminal event) with no
    // task-shaped trigger a skill description could key on.
    rules.push(
      `You are running a Dispatch job run (${jobRunId}). Job agents have a dedicated MCP route — use repo tools when relevant.`
    );
    if (suggestSessionRename) {
      rules.push(
        "Name the session. Once the topic of work is clear, call rename_session with a short name for that topic, task, or feature. The name is a stable label describing what the run is about, not a live status update."
      );
    }
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
          ? "Name the session with rename_session once the topic is clear — a short label for what the session is about, not a live status."
          : "Name the session. Once the topic of work is clear, call rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
      );
    }
    if (chatSurface) {
      rules.push(CHAT_SURFACE_GUIDANCE_RULE);
    }
    if (trimmed) {
      // One rule instead of two: surface values, and ask questions, with pins.
      // The tool schema carries the types, shortcut mechanics, and deletion.
      rules.push(
        "Surface important data to the user with pin — anything they may need to read or copy — and use shortcut pins to offer a next step. Route a structured decision, form, or status view to surface_create instead."
      );
    } else {
      rules.push(
        'Pin key info with pin so it surfaces in the sidebar — especially values users may need to copy/paste: URLs, commands, branch names, IDs, tokens, simulator UDIDs. Types: url (dev servers, docs), port (server ports), pr (PR links), filename (key files), code (short snippets, env vars, IDs), string (status, decisions), markdown (short structured summaries), shortcut (a button that sends a prompt back to you when clicked). To delete a stale pin, call list_pins then delete_pin with its id. For longer artifacts, post a file (attachments: [{ type: "file", path }]) and pin a reference.'
      );
      rules.push(
        "Offer a shortcut pin when you can name the user's likely next move (launch this, re-run that, confirm a single choice). Set confirm on destructive ones. For a structured decision, form, or status view — several related values, or something the user must fill in — use surface_create instead of a shortcut pin."
      );
    }
    rules.push(
      trimmed
        ? 'Share artifacts by posting them as files (post with attachments: [{ type: "file", path }]) — screenshots, logs, reports. A file path pasted into the stream is not a deliverable.'
        : "Playwright: default headless. Capture at least one screenshot per UI flow and post it as a file attachment. Call browser_close when done."
    );
    if (!trimmed) {
      rules.push(
        "For pull requests, use the create_pr MCP tool — not built-in PR skills or gh CLI."
      );
    }
    if (autoReview) {
      rules.push(
        "Autonomous Review is enabled. Before emitting done: commit and push your branch, open a draft PR via create_pr (don't override baseBranch — it defaults correctly), call list_personas, then launch relevant reviewers via launch_persona. Dispatch will guide the rest as it happens. Don't emit done until all submitted reviews are resolved — if a review prompt never arrived, check with review_list_feedback."
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
 * Decide whether the launch guidance should ask the agent to rename its
 * session. Returns `true` only when the existing name is a default
 * placeholder — never when the user (or a persona) chose a meaningful name.
 *
 * - Persona agents: never suggest (the persona name is the meaningful one).
 * - Job runs: suggest only when the name still matches the auto-generated
 *   `job-…-<jobRunIdPrefix>` shape.
 * - Everything else — including template-launched agents: suggest only when
 *   the name still matches the `agent-<last6>` placeholder generated when no
 *   name is supplied.
 *
 * Template launches are deliberately not special-cased. They are created with
 * the template's own (human-authored) name, so they never match the
 * placeholder and are never nudged. An earlier version returned `true` for any
 * `templateId`, with no name check — which re-nagged long-lived templated
 * agents on every server restart even once they carried a real, intentional
 * name. Every branch here now keys off the name alone, which makes the check
 * self-limiting: once an agent is named, it stays named, with no cross-restart
 * state to remember. This matches the web sidebar's manual rename-prompt
 * button, which has always gated on the placeholder name alone.
 */
export function shouldSuggestSessionRename(
  agentName: string | null | undefined,
  agentId: string,
  opts: {
    persona?: string | null;
    jobRunId?: string;
  }
): boolean {
  if (opts.persona) {
    return false;
  }

  const trimmed = agentName?.trim();
  if (opts.jobRunId) {
    const jobNameSuffix = `-${opts.jobRunId.slice(0, 8)}`;
    return (
      !!trimmed && trimmed.startsWith("job-") && trimmed.endsWith(jobNameSuffix)
    );
  }

  return trimmed === `agent-${agentId.slice(-6)}`;
}
