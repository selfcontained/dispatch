---
name: Persona Review
schedule: "0 9 * * 1"
timeout: 15m
needs_input_timeout: 18h
full_access: false
notify:
  on_complete: []
  on_error:
    - slack
  on_needs_input:
    - slack
---

# Persona Review

Assess the effectiveness of persona-driven code reviews over the past week. Run weekly.

## Data sources

Query the production database directly (connect to `127.0.0.1:5432`, database `dispatch`, user `dispatch`, password `dispatch`):

1. **persona_reviews** table — contains review results:
   - `persona`: which persona ran (e.g., "backend-security-review", "frontend-ux-review")
   - `status`: outcome of the review ("reviewing", "completed", etc.)
   - `verdict`: the persona's overall judgment
   - `summary`: text summary of findings
   - `files_reviewed`: JSON list of files the persona looked at
   - `created_at`: when the review ran

2. **agent_feedback** table — contains individual findings from persona agents:
   - `agent_id`: the persona agent that submitted it
   - `severity`: "critical", "high", "medium", "low", "info"
   - `file_path`, `line_number`: location of finding
   - `description`: what was found (text, not null)
   - `suggestion`: recommended fix (text, nullable)
   - `media_ref`: optional reference to a shared media artifact
   - `status`: "open", "resolved", "dismissed"
   - `created_at`: when submitted

Link feedback to reviews via `agent_feedback.agent_id = persona_reviews.agent_id`.

## Analysis (last 7 days)

For each persona type, assess:

### Volume & Completion
- How many reviews were run?
- How many completed vs. failed/timed out?

### Signal quality
- Read the actual feedback messages. Are they specific and actionable, or generic/boilerplate?
- What's the severity distribution? A persona that only produces "info" findings may not be pulling its weight.
- Are findings about the actual changes in the diff, or are they flagging pre-existing issues? (Pre-existing flags are noise.)

### Resolution rate
- What percentage of feedback items got resolved vs. dismissed?
- A high dismiss rate suggests the persona is generating noise.
- A high open rate suggests findings aren't being acted on (possibly because they're not useful enough).

### Patterns
- Are any personas consistently producing the same boilerplate feedback across different reviews?
- Are there personas that rarely find anything? That could mean the codebase is solid in that area, or the persona isn't looking hard enough.
- Which persona is producing the highest-value findings?

## Reporting

Use `job_log` to report progress as you analyze each persona type.

Call `job_complete` with a report containing:

- **per_persona**: For each persona type:
  - `reviews_run`: count
  - `completion_rate`: percentage
  - `feedback_count`: total findings
  - `severity_breakdown`: counts by severity
  - `resolution_rate`: percentage resolved vs. dismissed vs. open
  - `assessment`: 1-2 sentence qualitative judgment on signal quality
  - `recommendation`: keep as-is, adjust prompt, or consider removing
- **overall**: Summary across all personas — total reviews, best/worst performers, any systemic issues.

If no persona reviews exist in the last 7 days, call `job_complete` with a note that no reviews were found and no analysis is possible.
