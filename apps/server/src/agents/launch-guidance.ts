import { buildPostEnvelope } from "../chat/envelope.js";
import { PLUGIN_AGENT_TYPES, type AgentType } from "../shared/agent-types.js";

/**
 * Agent types that can install the Dispatch plugin, whose skills carry the
 * depth the trimmed rules drop.
 */
const PLUGIN_CAPABLE_AGENT_TYPES: ReadonlySet<AgentType> = new Set(
  PLUGIN_AGENT_TYPES
);

/** A startup file as `seedInitialFiles` reports it, for the first turn. */
export type StartupFile = {
  fileName: string;
  displayName: string;
  source: string;
  description: string | null;
};

/**
 * The Chat feed's launch post, fixed before the CLI command is built so the
 * first turn can carry its id. `attachmentLines` are the recorder's own
 * envelope lines for the startup files and links — one source, so the
 * pane and the post agree.
 */
export type ChatLaunchPost = {
  messageId: string;
  attachmentLines: string[];
};

export type StartupTurnInput = {
  initialPrompt?: string;
  /** Raw startup URLs. */
  initialLinks?: string[];
  initialFiles?: StartupFile[];
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
  opts: { jobRunId?: string }
): string | undefined {
  const post = startup.chatLaunchPost;
  if (!opts.jobRunId && post) {
    return buildPostEnvelope({
      blockId: post.messageId,
      from: { kind: "user" },
      text: startup.initialPrompt?.trim() ?? "",
      attachmentLines: post.attachmentLines,
    });
  }
  return buildStartupPrompt(
    startup.initialPrompt,
    startup.initialLinks ?? [],
    startup.initialFiles ?? []
  );
}

/**
 * Compose the first user-message-style prompt handed to the agent on
 * launch — formats `initialPrompt`, `initialLinks`, and `initialFiles` into
 * a single string the CLI passes through as the opening turn.
 *
 * Returns `undefined` when there's nothing to attach (the caller can then
 * skip the prompt entirely).
 */
export function buildStartupPrompt(
  initialPrompt: string | undefined,
  initialLinks: string[],
  initialFiles: StartupFile[]
): string | undefined {
  const trimmedPrompt = initialPrompt?.trim() || "";
  if (initialLinks.length === 0 && initialFiles.length === 0) {
    return trimmedPrompt || undefined;
  }

  const sections = [
    "Startup context is attached to this session.",
    "Inspect the provided links and shared files before acting. Use Dispatch shared-file tools to access attached files; do not try to locate them by searching the filesystem by name.",
  ];

  if (trimmedPrompt) {
    sections.push(`Instructions:\n${trimmedPrompt}`);
  }

  if (initialLinks.length > 0) {
    sections.push(
      ["Links:", ...initialLinks.map((url) => `- ${url}`)].join("\n")
    );
  }

  if (initialFiles.length > 0) {
    sections.push(
      [
        "Attached files:",
        ...initialFiles.map((file) => {
          const detail = file.description?.trim();
          const suffix = detail ? ` — ${detail}` : "";
          return `- ${file.displayName}${suffix} (available via dispatch shared files)`;
        }),
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

/**
 * Build the numbered launch guidance text shared by all CLI agent types.
 *
 * `trimmedGuidance` swaps the verbose rules for short generic ones. Two
 * different things carry the detail it drops, and the distinction matters:
 *
 * - **The MCP tool schemas.** `post`'s own description already lists
 *   every block kind and attachment type. Restating that here duplicated a
 *   description the agent already has, in every session, whether or not the
 *   flow ever comes up. The trimmed rules say *that* these tools matter and
 *   leave the *how* to the schema. This half does not depend on the plugin.
 * - **Plugin skills**, for the Playwright methodology (→ `ui-validation` +
 *   `sharing`) and the pull-request routine (→ `review-workflow`). This
 *   half genuinely needs the plugin installed, which is why the setting is
 *   worded as an assertion about it.
 *
 * What never trims is the rule with no replacement anywhere: the no-task
 * guardrail. Nothing else states it, and it has to fire before a task exists.
 *
 * A short file-posting nudge survives the trim on purpose. That habit was
 * already stated in two always-on places and agents still pasted file paths
 * into chat, so it's the one tool-routing rule with a demonstrated failure
 * history — the toggle tests the PR line, not this.
 *
 * The Autonomous Review rule is short for *everyone*, toggle or not, and
 * that has nothing to do with the plugin: the reactive part ("after a
 * review arrives, do X") reaches the agent with the review itself, as the
 * envelope of the review block. What remains is the part nothing can
 * deliver later: the gate the agent must already know before it decides it
 * is done.
 */
export function buildLaunchGuidance(
  agentId: string,
  opts: {
    agentType?: AgentType;
    jobRunId?: string;
    suggestSessionRename?: boolean;
    autoReview?: boolean;
    trimmedGuidance?: boolean;
  }
): string {
  const {
    agentType,
    jobRunId,
    suggestSessionRename,
    autoReview,
    trimmedGuidance,
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
    rules.push(
      trimmed
        ? "Say the plan before a long first turn. On anything beyond a small, obvious change, read enough to be sure of the approach, say what you intend to do, and stop for the user's answer before editing or running commands at length."
        : "Say the plan before a long first turn. The user reads your stream between turns, not during one: a turn that runs for ten minutes is ten minutes they cannot steer. So on anything beyond a small, obvious change, read enough to be sure of the approach, say what you intend to do in a few lines, and stop there. Start the work once they answer. A question with options (post) is right when the approach is a real choice; plain text is right when you just need a yes. This is about the shape of the first turn, not its length — once the plan is agreed, long turns are fine."
    );
    if (suggestSessionRename) {
      rules.push(
        trimmed
          ? "Name the session with rename_session once the topic is clear — a short label for what the session is about, not a live status."
          : "Name the session. Once the topic of work is clear, call rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
      );
    }
    if (trimmed) {
      // One rule: everything the user needs to read, copy or decide is a
      // block. The tool schema carries the kinds and attachment types.
      rules.push(
        "Put anything the user needs to read, copy or click in the stream: post with link, pr, code or file attachments, and ask a decision with a question or form block rather than in prose."
      );
    } else {
      rules.push(
        "Values the user needs — dev server URLs, PR links, branch names, IDs, tokens, commands — go in the stream as attachments on a post: link (URLs), pr (pull requests), code (snippets, env vars, IDs), file (screenshots, logs, reports). A path or URL pasted into prose is easy to lose; an attachment is not."
      );
      rules.push(
        "When you need a decision, post a question block (a row of options, freeform allowed when useful) or a form block for several fields. Waiting on an answer is visible to the user; a question buried in prose is not."
      );
    }
    rules.push(
      trimmed
        ? 'Share artifacts by posting them as files (post with attachments: [{ type: "file", path }]) — screenshots, logs, reports. A file path pasted into the stream is not a deliverable.'
        : "Playwright: default headless. Capture at least one screenshot per UI flow and post it as a file attachment. Call browser_close when done."
    );
    if (!trimmed) {
      rules.push(
        "For pull requests, use the gh CLI (gh pr create) and post the PR as a pr attachment."
      );
    }
    if (autoReview) {
      rules.push(
        "Autonomous Review is enabled. Before you finish: commit and push your branch, open a draft PR (gh pr create --draft) and post it as a pr attachment, call list_personas, then launch relevant reviewers with launch_agent (persona: <slug>, prompt: your briefing). Each reviewer posts a review block to you; work its findings (mark each fixed, or dismiss it with a note, with update state) and answer questions in the block's thread. Don't finish until every finding is resolved."
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
