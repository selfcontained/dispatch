---
name: personalities
description: Change how Dispatch agents communicate — tone, verbosity, how much they narrate. Use when the user comments on the way agents talk rather than what they do — too wordy, be blunter, skip the preamble.
---

# Personalities: how agents communicate

A personality is a short saved instruction that shapes the **voice** of every
standard agent launched afterward. It is about delivery — tone, length, how much
process gets narrated — not about capability or workflow.

The signal is a complaint about form rather than substance: "too wordy", "stop
apologizing", "just give me the answer", "I want the reasoning spelled out". If
the user is asking agents to _do_ something differently, that is a template
prompt or repo guidance, not a personality.

Personalities are unrelated to review personas. Personas are reviewers with a
domain lens (see the `personas` skill); personalities are the house style.

## Tools

```
list_personalities       — saved personalities plus the currently active ID
create_personality       name, prompt — saved but NOT activated
update_personality       id, name?, prompt?
set_active_personality   id
clear_active_personality — back to no personality text
delete_personality       id
```

`prompt` is capped at 1000 characters, `name` at 80. **Creating does not
activate** — call `set_active_personality` as a second step, or the user will
wonder why nothing changed.

Activation applies to **subsequently launched** standard agents. It does not
retroactively change a session already running, including yours. Say so when you
set one, otherwise the user tests it in the current session and concludes it is
broken.

## Writing one

The 1000-character budget is small on purpose. Spend it on rules that change
observable output:

```
Lead with the answer, then the reasoning. No preamble, no restating the
question. Prefer a short paragraph over a bulleted list unless the content is
genuinely a list. Never apologize for a mistake — just state the correction and
move on. When you are unsure, say which part you are unsure about instead of
hedging the whole answer.
```

What works:

- **Directives about output shape.** Length, ordering, formatting, what to omit.
- **Named anti-patterns.** "Don't open with 'Great question'" beats "be natural"
  — a concrete prohibition is checkable, a vibe is not.
- **A stated default with an escape hatch.** "Default to three sentences; expand
  when the answer genuinely needs it" avoids terse-but-useless replies.

What does not:

- Workflow rules ("always run the tests"). Those belong in repo guidance, where
  they apply regardless of who is talking.
- Tool instructions. A personality is loaded for every agent; tool guidance
  belongs in a skill that loads when it is relevant.
- Long persona fiction. Backstory burns the budget and rarely changes output.

## Managing them

Keep a small set with names that say when to use them — "Terse", "Explain
Everything", "Pairing" — rather than one that gets rewritten every time the mood
changes. `clear_active_personality` returns to the default voice; reach for it
before assuming a personality is at fault for something.
