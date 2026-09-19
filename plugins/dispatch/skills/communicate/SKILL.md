---
name: communicate
description: Pick the shape for something you are about to tell the user — a plain reply, a question they answer in one click, a form, a file, a link, or a checklist. Use when you need a decision from them, have progress or a result to report, or produced something they should look at.
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

| What you have                                                      | Send it as                                                      | Depth       |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | ----------- |
| An explanation, an answer, a short result                          | your ordinary reply — it streams; do not repeat it with `post`  | —           |
| A question with a finite set of answers                            | `post` with `question`                                          | below       |
| Several related values, or anything they must fill in              | `post` with `form`                                              | below       |
| A file, screenshot, log, or report                                 | `post` with a file attachment                                   | `sharing`   |
| A link — a dev URL, a doc                                          | `post` with `link`                                              | —           |
| A pull request                                                     | `post` with a `pr` attachment                                   | —           |
| A value they will copy — an id, a command, an env var, a port      | `post` with a `code` attachment                                 | —           |
| A checklist they will watch you work through                       | `post` with `tasks`, ticked with `update`                       | below       |
| Something worth reaching them away from the session                | `post` with `notify: true` (browser, and Slack when configured) | —           |
| State that keeps changing over a long task                         | one `post`, revised with `update`                               | below       |
| A message to another agent                                         | `post` with `to: <agentId>`                                     | `subagents` |

Take the narrowest row that fits. A `code` attachment is not a substitute for a
form, and a `tasks` block is overkill for one URL. When two rows could work, the
plainer one wins: the user is already reading the stream.

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

You do not need to say you are stopped. An open `question` or `form` addressed
to the user is what shows you as Waiting; answering it is what clears it. Ask
with a control and the status follows.

Do not ask what you can determine yourself. A question costs the user a context
switch; reading one more file costs you a tool call.

## Reporting

When work will run long, `post` once, then keep revising that same block with
`update` as it progresses. One block that ends up describing the result beats a
trail of notes that are each stale a minute after they land. A `tasks` block
does the same for a checklist: post the items, tick them as you go.

Keep the prose and the evidence separate: the reply says what happened, the
file or link carries the bulk.

## Not this skill's job

- **How you sound** — tone, length, how much you narrate — is `personalities`.
- **Talking to other agents.** `post` with `to` is the mechanism; when to
  delegate, and what to put in a handoff, is `subagents`.
