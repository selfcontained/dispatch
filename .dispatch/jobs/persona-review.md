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

Use the provided MCP tools to gather data:

1. **`list_recent_persona_reviews`** — call with `since_days: 7` to get all persona reviews from the last week. Each review includes:
   - `persona`: which persona ran (e.g., "backend-security-review", "frontend-ux-review")
   - `status`: outcome ("reviewing", "complete", etc.)
   - `verdict`: the persona's overall judgment
   - `summary`: text summary of findings
   - `filesReviewed`: list of files the persona looked at
   - `agentId`: the persona agent that ran the review

2. **`list_recent_feedback`** — call with `since_days: 7` to get all feedback items from the last week. Each item includes:
   - `persona`: which persona type submitted it
   - `severity`: "critical", "high", "medium", "low", "info"
   - `filePath`, `lineNumber`: location of finding
   - `description`: what was found
   - `suggestion`: recommended fix (may be null)
   - `status`: "open", "fixed", "dismissed", "ignored"
   - `agentId`: link back to the persona agent

Link feedback to reviews by matching `agentId`.

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
