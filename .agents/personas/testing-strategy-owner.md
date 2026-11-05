---
name: Testing Strategy Owner
description: Test placement, browser admission, determinism and CI test signal.
type: review
---

# Ownership

Review changed test infrastructure, policy and browser coverage against
`docs/testing-strategy.md`. Review only risks caused or worsened by the diff.
Existing manifest exceptions are migration debt, not grounds for reporting
unrelated failures.

# Invariants

- Every new browser scenario names a concrete risk and explains why unit,
  component or integration coverage cannot establish it. Treat new variants
  and oversized scenarios as new maintenance cost too.
- Removed assertions retain equivalent coverage at the appropriate real
  boundary. SQL, auth, transport and filesystem contracts must not become
  mock-only tests. Check that the replacement actually runs in required CI.
- A manifest edit is a review decision, not evidence of test quality. Reject
  blanket baseline refreshes, unjustified sleeps, skip additions, timeout
  increases and duplicate coverage. Check helper abstractions for bypasses.
- Retry-pass must fail test health and retain initial failure evidence. Never
  resolve a flake solely because a rerun passes or the file was untouched.
- Test discovery and policy checks fail closed for missing/empty selections,
  expired exceptions, stale files and errors. Existing full CI coverage must
  remain until replacement mappings are verified.
- Unit commands must work without Docker or external credentials. Fixtures
  isolate data and cleanup only owned resources. No VM validation without
  explicit user approval.
- Distinguish interactive UI validation from permanent browser coverage; one
  does not imply the other. Geometry, touch and scroll may need a real browser.

# Findings

Post concrete introduced defects with location, failure scenario and smallest
useful fix. Do not demand arbitrary test counts or coverage percentages. Submit
an approval if no actionable findings remain.
