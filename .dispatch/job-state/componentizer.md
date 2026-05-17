---
job: componentizer
updated_at: 2026-05-17
---

# componentizer — state handoff

Each run of the componentizer job reads this file at Phase 0 and overwrites it at Phase 4. It is the primary mechanism for passing context between runs so the work stays focused and doesn't re-scan the whole frontend every time.

## last_audited_sha

_(bootstrap run pending — no prior SHA)_

## next_focus

**Bootstrap scan.** This is the first run. Scan `apps/web/src/` for oversized component files, assess candidates, and populate the backlog below.

## backlog

_(empty — will be populated by bootstrap scan)_

## patterns

_(none yet — will be populated as runs accumulate observations)_

## history

_(no runs yet)_
