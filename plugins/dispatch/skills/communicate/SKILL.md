---
name: communicate
description: Pick the shape for something you are about to tell the user — a plain or threaded reply, a question they answer in one click, a form, a file, a link, or a checklist. Use when you need a decision from them, have progress or a result to report, or produced something they should look at.
---

# Reaching the user

A Dispatch session has several ways to reach the person reading it, and the
default — more prose in the reply — is the worst one for anything structured.
Which shape to use is decided _before_ you know which tool you want, which is
why it lives here instead of inside any one of them.

**The failure this prevents:** a five-field question asked as a paragraph, a
decision the user has to answer by typing it back, a result buried in narration
they must scroll a transcript to find again.

## The router

The user reads your stream. Your ordinary reply already appears there as you
write it, so `post` is for what plain text cannot do. Everything below lands in
the same stream; the rows differ in what the user can _do_ with it.

| What you have                                                 | Send it as                                                      | Depth       |
| ------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| A short explanation, answer, or result                        | your ordinary reply — it streams; do not repeat it with `post`  | —           |
| A scoped side answer under a specific post                    | `post` with `replyTo` and `text`; do not repeat in prose        | below       |
| A plan, design, or analysis longer than a screen              | `post` with a `.md` file attachment, summary in the reply       | `sharing`   |
| A question with a finite set of answers                       | `post` with `question`                                          | below       |
| Several related values, or anything they must fill in         | `post` with `form`                                              | below       |
| A file, screenshot, log, or report                            | `post` with a file attachment                                   | `sharing`   |
| A link — a dev URL, a doc                                     | `post` with `link`                                              | —           |
| A pull request                                                | `post` with a `pr` attachment                                   | —           |
| A value they will copy — an id, a command, an env var, a port | `post` with a `code` attachment                                 | —           |
| A checklist they will watch you work through                  | `post` with `tasks`, ticked with `update`                       | below       |
| Something worth reaching them away from the session           | `post` with `notify: true` (browser, and Slack when configured) | —           |
| Progress during a long task                                   | ordinary replies; `tasks` for a persistent checklist            | below       |
| A message to another agent                                    | `post` with `to: <agentId>`                                     | `subagents` |

Take the narrowest row that fits. A `code` attachment is not a substitute for a
form, and a `tasks` block is overkill for one URL. When two rows could work, the
plainer one wins: the user is already reading the stream. The one exception is
length: anything longer than a screen goes in a file, however plain it is.

## Main conversation or thread?

Keep the main task, progress updates, broader decisions, and final result in
the main conversation. Use a thread for a self-contained side question,
clarification, or follow-up tied to a specific post when the exchange would
interrupt the ongoing conversation — similar to good Slack etiquette.

For example, while implementing a feature, “What does SSE mean?” can be
answered under that question; “Change the feature to use polling” steers the
main task and belongs in the main conversation. A question mark alone is not
a reason to start a thread.

To answer a scoped question in a thread, use
`post({ replyTo: "<question post id>", text: "<answer>" })`. Use the exact id
from its DISPATCH POST envelope or a post result; no `question` payload is
needed for an answer. Do not repeat the answer in your ordinary reply.
Continue the main task there, surfacing any consequence of the side exchange
that changes its scope, approach, or outcome.

If the user already wrote in a thread, ordinary replies land there
automatically. Stay in that thread without an extra `post` just to thread the
answer. Do not move every reply into a thread or create a new thread for each
follow-up.

## Asking

Ask through a control the user can click, not a sentence they have to answer in
prose:

- **A finite choice** — `post` with `question.options` (up to 10). The options
  render as buttons; their pick comes back as a DISPATCH POST with `replyTo`
  set to your question, so you always know what was answered. Add
  `allowFreeform` when a typed answer also makes sense.
- **More than one field, or a field with a real answer** — `post` with
  `form`. Its fields are the only way to collect several values in one
  submission; an option labelled "Add explanation" with nowhere to type is not
  a form.
- **One obvious next move** — a `question` with one option is fine.

Dispatch derives activity from the runtime and open questions or forms; do not
emit status events or claim a status yourself. Continue independent work while
an answer is pending. Treat the actual answer as input, not the posting receipt
or a delivery indicator. Cancel an obsolete ask with `update` and
`state: { cancellation: "<reason>" }`; do not invent an answer to close it.

Do not ask what you can determine yourself. A question costs the user a context
switch; reading one more file costs you a tool call.

## Reporting

Give concise progress updates and the final result in ordinary replies. They
stream automatically; do not duplicate them with `post`. For a persistent
checklist, post a `tasks` block and tick its items with `update`.

With automatic delivery, a new user message in the same conversation may steer
the running turn; user messages for a different conversation queue. Incorporate
steering into the active task and continue authorized work. Automatic and queued
messages do not cancel running work. A user may explicitly choose Interrupt in
the composer to request cancellation, then start a new turn where they posted.
Cancellation is cooperative: a request is not proof a tool stopped. Receipt,
pickup, and an answer are distinct:
an interim reply or response
segment is not automatically a completed answer to every pending request.

Keep the prose and the evidence separate: the reply says what happened, the
file or link carries the bulk. The same split applies to a plan or design
write-up: a few sentences on the approach and the decisions it needs in the
reply, the sections themselves in a markdown file the user can open, forward,
and see revised with `update` as the plan changes. An `update` changes the
block where it was posted, which may be several screens up by then, so say in
your reply what changed.

## Not this skill's job

- **How you sound** — tone, length, how much you narrate — is `personalities`.
- **Talking to other agents.** `post` with `to` is the mechanism; when to
  delegate, and what to put in a handoff, is `subagents`.
