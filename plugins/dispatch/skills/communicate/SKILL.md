---
name: communicate
description: Pick the channel for something you are about to tell the user — a reply, a question they answer in one click, a sidebar form, an artifact, or a pin. Use when you need a decision from them, have progress or a result to report, or produced something they should look at.
---

# Reaching the user

A Dispatch session has several ways to reach the person reading it, and the
default — more prose in the reply — is the worst one for anything structured.
Which channel to use is decided _before_ you know which tool you want, which is
why it lives here instead of inside any one of them.

**The failure this prevents:** a five-field question asked as a paragraph, a
decision the user has to answer by typing it back, a result buried in narration
they must scroll a transcript to find again.

## The router

| What you have                                                      | Send it as                                            | Depth        |
| ------------------------------------------------------------------ | ----------------------------------------------------- | ------------ |
| An explanation, an answer, a short result                          | your ordinary reply                                   | —            |
| One small fact they will copy or return to — URL, port, branch, id | a pin (`dispatch_pin`)                                | —            |
| A question with a finite set of answers                            | `dispatch_chat_post` with `kind: "question"`          | below        |
| A question whose answer is one obvious next move                   | a `shortcut` pin                                      | below        |
| Several related values, or anything they must fill in              | a surface (`dispatch_surface_create`)                 | `surfaces`   |
| A file, screenshot, log, or report                                 | `dispatch_share_file`                                 | `sharing`    |
| Something a drawing explains better than prose                     | the whiteboard                                        | `whiteboard` |
| Something worth reaching them away from the session                | `dispatch_notify` (Slack; needs a configured webhook) | —            |
| State that keeps changing over a long task                         | one `kind: "update"` post, edited in place            | below        |

Take the narrowest row that fits. A pin is not a substitute for a form, and a
surface is overkill for one URL.

## Asking

Ask through a control the user can click, not a sentence they have to answer in
prose:

- **A finite choice** — `dispatch_chat_post` with `kind: "question"` and
  `question.options` (up to 10). Their pick comes back as a message with
  `replyTo` set to your question, so you always know what was answered. Add
  `allowFreeform` when a typed answer also makes sense.
- **One obvious next move** — a `shortcut` pin. The label is the button, the
  value is the prompt you receive. Set `confirm` on anything destructive.
- **More than one field, or a field with a real answer** — a surface. Its form
  is the only channel that collects several values in one submission; an action
  button labelled "Add explanation" with nowhere to type is not a form.

Whichever you use, if the answer is blocking you, emit `waiting_user` alongside
it. The control is how they answer; the event is what tells them you are
stopped. Neither does the other's job.

Do not ask what you can determine yourself. A question costs the user a context
switch; reading one more file costs you a tool call.

## Reporting

Post a `kind: "update"` when work will run long, then keep editing that same
message with `dispatch_chat_update` as it progresses. One message that ends up
describing the result beats a trail of notes that are each stale a minute after
they land. Use `kind: "summary"` for the wrap-up when a task had enough moving
parts that the outcome deserves its own card.

Keep the prose and the evidence separate: the message says what happened, the
shared artifact or surface carries the bulk.

## Not this skill's job

- **How you sound** — tone, length, how much you narrate — is `personalities`.
- **Whether the user is reading Chat or the terminal.** `dispatch_chat_post`'s
  own description settles that, and it changes with the installation's
  chat-surface setting. This skill is about the shape of what you send, not
  which pane it lands in.
- **Status events.** `dispatch_event` is always relevant, so it lives in the
  launch guidance rather than in a skill that only loads on a match.
