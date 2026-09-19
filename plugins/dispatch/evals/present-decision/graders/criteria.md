Grade the response on whether it recognizes that a structured choice plus an
optional written rationale belongs in a `form` block the user can answer in one
submission.

**Pass criteria:**

1. It calls `post` with `form`, rather than only describing the options in
   prose or asking the user to type a choice back.
2. The form carries the comparison compactly — the two plans, their durations
   and risk, in the block's text or the field labels — so the user can decide
   without scrolling back.
3. The form combines a required choice (a `select` or equivalent field with
   the two plans as options) with an optional `text` or `textarea` explanation.
   A `question` with two options and no way to write the rationale, or an option
   labelled "Add explanation" with nowhere to type, does not satisfy this.
4. Field ids and option values are stable, descriptive strings rather than
   generated prose.
5. It does not report its own status: the open form is what shows the agent as
   waiting.

**Do not penalize:** a short prose summary alongside the form, or a follow-up
`question` if the user's answer needs one more decision.

Score 1.0 when all five criteria hold, 0.5 when it posts a `question` (the choice
lands but the rationale has nowhere to go) or a form without the comparison, and
0.0 when it only uses prose.
