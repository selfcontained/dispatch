## What's Changed
* Fix tmux "terminal does not support clear" under Bun runtime by @selfcontained in https://github.com/selfcontained/dispatch/pull/434


**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.18.11...v0.18.12

```dispatch-update
{
  "mode": "required",
  "title": "Bun runtime cutover (carries PTY TERM fix)",
  "summary": "This release carries a fix for a PTY TERM regression introduced in the Bun runtime cutover, and continues to gate the assisted flow for any install jumping from a Node-era release. Two paths through the assisted update: an install already on the Bun runtime needs only a routine artifact swap and restart; an install coming from a Node-era startup path needs the full Bun runtime cutover plus the fixed artifact.",
  "instructions": "1. Inspect the current install and confirm how the service is launched today. Identify whether you are already on a Bun runtime (routine-patch path) or coming from a Node-era release (full Bun migration path).\n2. Fetch the release artifact for the target tag and install the Bun runtime artifacts for the current platform.\n3. Migrate the service entrypoint to the Bun wrapper or compiled binary path expected by this release. If already on Bun, confirm the entrypoint matches the new release; the migration step is a no-op on that path.\n4. Remove or replace stale runtime artifacts that could cause the service to launch an older binary after restart. Required on both paths because this release's fix ships in those artifacts.\n5. Restart the service, confirm health, and verify the running version converged to the requested tag before declaring success.",
  "requiredChecks": [
    "expected_runtime_artifact",
    "service_entrypoint",
    "service_restarted",
    "health_endpoint",
    "version_converged"
  ],
  "rollbackGuidance": "If the service does not return healthy after the update, restore the previous known-good service entrypoint and runtime artifacts, restart the service, and confirm the last healthy version before attempting deeper diagnosis. On the routine-patch path rollback is a binary swap; on the full-migration path you may also need to restore the prior Node-era entrypoint.",
  "appliesFrom": "v0.18.0"
}
```
