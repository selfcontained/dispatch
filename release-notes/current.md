## What's Changed
* Cut Dispatch server runtime over to Bun by @selfcontained in https://github.com/selfcontained/dispatch/pull/414
* Run assisted-update helper with Bun by @selfcontained in https://github.com/selfcontained/dispatch/pull/433


**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.18.10...v0.18.11

```dispatch-update
{
  "mode": "required",
  "title": "Bun runtime cutover",
  "summary": "This release moves Dispatch from the Node.js runtime path to compiled Bun binaries and updates service management to launch the Bun wrapper/binary entrypoint instead of the old Node-based startup path.",
  "instructions": "1. Inspect the current install and confirm how the service is launched today.\n2. Fetch the release artifact for the target tag and install the Bun runtime artifacts for the current platform.\n3. Migrate the service entrypoint to the Bun wrapper or compiled binary path expected by this release.\n4. Remove or replace stale runtime artifacts that could cause the service to launch an older binary after restart.\n5. Restart the service, confirm health, and verify the running version converged to the requested tag before declaring success.",
  "requiredChecks": [
    "expected_runtime_artifact",
    "service_entrypoint",
    "service_restarted",
    "health_endpoint",
    "version_converged"
  ],
  "rollbackGuidance": "If the service does not return healthy after the runtime migration, restore the previous known-good service entrypoint and runtime artifacts, restart the service, and confirm the last healthy version before attempting deeper diagnosis.",
  "appliesFrom": "v0.18.0"
}
```
