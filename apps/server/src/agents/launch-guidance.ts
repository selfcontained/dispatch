import { buildPostEnvelope } from "../chat/envelope.js";

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
 * The agent's first user turn. With a launch post
 * recorded, the prompt is wrapped in the same `--- DISPATCH CHAT ---`
 * envelope a Chat message is injected with (id = the launch post, the
 * attachments listed the same way, the trailer pointing the agent at
 * post), so an agent started from the stream knows to answer
 * there. Job instructions live in the launch guidance, but ACP still needs
 * a user turn to begin execution. Jobs get a kickoff when no explicit first
 * prompt is supplied. Ordinary sessions without a task stay idle.
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
  const prompt = buildStartupPrompt(
    startup.initialPrompt,
    startup.initialLinks ?? [],
    startup.initialFiles ?? []
  );
  return (
    prompt ??
    (opts.jobRunId
      ? "Run the Dispatch job described in your instructions. Follow its lifecycle requirements and report the outcome with a job terminal tool."
      : undefined)
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

/** Build the startup rules for every agent, independent of plugin installation. */
export function buildLaunchGuidance(
  agentId: string,
  opts: {
    jobRunId?: string;
    suggestSessionRename?: boolean;
  }
): string {
  const { jobRunId, suggestSessionRename } = opts;
  const rules: string[] = [];

  if (jobRunId) {
    // Every rule on this branch is a runtime
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
      "Finish with exactly one job terminal tool: job_complete, job_failed, or job_needs_input. Follow the job's report and continuation requirements."
    );
  } else {
    rules.push(
      "No task, no work. If the user hasn't explicitly asked for a change, fix, review, or investigation, ask what they want — don't infer a task from branch/worktree context alone."
    );
    rules.push(
      "Keep the user informed. Your replies stream live: briefly explain your approach before substantial work and give concise progress updates as you work. Continue within the user's authorized scope; ask when a missing decision or permission prevents progress. Dispatch tracks turn activity automatically."
    );
    if (suggestSessionRename) {
      rules.push(
        "Name the session. Once the topic of work is clear, call rename_session with a short name for that topic, task, or feature — the reason for the session. The name is a stable label describing what the session is about, not a live status update. Rename again if the work shifts substantially to a new topic."
      );
    }
    rules.push(
      "Values the user needs — dev server URLs, PR links, branch names, IDs, tokens, commands — go in the stream as attachments on a post: link (URLs), pr (pull requests), code (snippets, env vars, IDs), file (screenshots, logs, reports). A path or URL pasted into prose is easy to lose; an attachment is not."
    );
    rules.push(
      "When you need a decision, post a question block (a row of options, freeform allowed when useful) or a form block for several fields. Waiting on an answer is visible to the user; a question buried in prose is not."
    );
    rules.push(
      "Playwright: default headless. Capture at least one screenshot per UI flow and post it as a file attachment. Call browser_close when done."
    );
    rules.push(
      "For pull requests, use the gh CLI (gh pr create) and post the PR as a pr attachment."
    );
    rules.push(
      "For a requested persona review, call list_personas then launch_agent with persona and a self-contained briefing. The review arrives as a new prompt: finish independent work and end the turn instead of polling or waiting. Reply to each finding with post in its thread (replyTo, and to for the reviewer); its reviewer verifies and resolves it with update."
    );
  }

  rules.push(
    "The Dispatch MCP connection is scoped to this session. Use the provided tools and repo tools where relevant. DISPATCH_AGENT_ID identifies this agent and DISPATCH_FILES_DIR is its shared-file directory. Use list_files for shared-file discovery and post with file attachments to share artifacts. Work from the assigned working directory, including its worktree when present."
  );

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
