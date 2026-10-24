import { Code, H3, P, Section } from "./primitives";

export const TASKS_DOC_URL =
  "https://github.com/selfcontained/dispatch/blob/main/docs/19-tasks.md";

export function TasksContent() {
  return (
    <>
      <P>
        <strong>Tasks</strong> are a board per project, opened from{" "}
        <strong>Tasks</strong> in the sidebar. A task sits in one of the
        project's columns and outlives the agents that work it: a builder picks
        it up, a reviewer follows, and each of them is recorded against the
        task. Moving a card is how work gets handed to the next agent.
      </P>

      <Section>
        <H3>Columns</H3>
        <P>
          A new board starts with <Code>backlog</Code>, <Code>ready</Code>,{" "}
          <Code>in_progress</Code>, <Code>in_review</Code>, and{" "}
          <Code>done</Code>. Add columns with <strong>Add column</strong>, and
          rename, reorder, or delete them from each column's menu; a column that
          still holds tasks can't be deleted. One column is the done column —
          entering it marks the task completed, and leaving it clears that.
        </P>
      </Section>

      <Section>
        <H3>Triggers</H3>
        <P>
          Choose <strong>Automation…</strong> in a column's menu to launch a
          project template whenever a task <em>enters</em> that column. Edits
          and reorders inside the column never fire it. The dialog sets:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Template</strong>, plus optional <strong>Runtime</strong>{" "}
            and <strong>Model</strong> overrides.
          </li>
          <li>
            <strong>Assign the launched agent</strong> — the new agent becomes
            the task's assignee.
          </li>
          <li>
            <strong>Pass task as context</strong> — appends the task briefing
            (title, body, column, links, and how to use the task tools) to the
            template's prompt. The template always receives <Code>Task ID</Code>
            , <Code>Task Title</Code>, and <Code>Task Body</Code> as arguments.
          </li>
          <li>
            <strong>Also fire when created here</strong> — a task created in the
            column fires the trigger too.
          </li>
        </ul>
        <P>
          If the task's agent is still working, the move asks before launching
          another. A failed launch never undoes the move; the card shows the
          failure instead.
        </P>
      </Section>

      <Section>
        <H3>Conversation</H3>
        <P>
          Each task has its own conversation. Posting there reaches the current
          assignee, or whoever you <Code>@mention</Code>, and the task's agents
          reply in place. Deleting a task deletes its conversation.
        </P>
      </Section>

      <Section>
        <H3>Task tools</H3>
        <P>
          Agents work the board through MCP tools scoped to their own project:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>task_list</Code> — thin rows, filterable by column or{" "}
            <Code>assignedToMe</Code>.
          </li>
          <li>
            <Code>task_get</Code> — one task with its agents and recent
            activity.
          </li>
          <li>
            <Code>task_create</Code> — create a task in the first or a named
            column.
          </li>
          <li>
            <Code>task_update</Code> — edit, move by column key, assign{" "}
            <Code>self</Code> or <Code>none</Code>, and add links such as PRs.
          </li>
          <li>
            <Code>task_comment</Code> — post on the task's conversation, or to
            another agent on the task.
          </li>
        </ul>
        <P>
          A tool move follows the same trigger rules, but it won't relaunch over
          another running agent.
        </P>
      </Section>

      <Section>
        <P>
          Data model, API, and the full trigger rules are in{" "}
          <a
            href={TASKS_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            docs/19-tasks.md
          </a>
          .
        </P>
      </Section>
    </>
  );
}
