# Reading cached PR risk through MCP

`get_pull_request_risk({ agentId, url })` reads exactly one PR from an explicit
agent's existing inventory. URLs use the existing HTTPS GitHub PR canonicalizer.
The authenticated MCP caller can read itself, or an agent visible through the
existing repository/lineage listing that also shares its non-null project.
Unknown and unauthorized agents share one error. Invalid URLs, untracked PRs,
and unavailable tracking return tool errors; this tool never discovers PRs.

The response identifies its source as `cached_inventory`. `headSha` and
`checkedAt` describe the cached GitHub observation, not a live freshness claim.
`lifecycle` is the cached PR lifecycle. `state` preserves the risk display state
(disabled, waiting_ci, waiting_review, evaluating, deferred, capacity, daily_cap,
rate_limited, failure, unavailable, not_ready), or is absent, stale, current, or
inconclusive. Absent means there is no cached result, not that work was queued.
Only an open PR with a matching cached head and no display lifecycle override
can have `currentAssessment`; an abstention remains inconclusive. Historical
results are separately returned as `priorAssessment`. Assessment provenance
includes assessed head, time, provider status and prompt version. Metrics and
confidence are the existing display summary; private review content, raw prompts
and secrets are excluded. Disabled mode returns neither current nor historical
assessment. No result is merge approval (`mergeApproval` is always false).

Reads do not refresh inventory, schedule assessments, invoke providers, change
settings, merge or notify. No refresh control is accepted. This deliberately
cannot recover an assessment that the authoritative runtime inventory no longer
retains; it reports absent instead of performing a database or provider lookup.
