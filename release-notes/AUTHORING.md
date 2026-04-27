# Assisted Update Metadata Authoring

When a PR introduces an assisted-update requirement for the next release, author
or update `release-notes/next-assisted-update.json`.

## File lifecycle

- The file lives at `release-notes/next-assisted-update.json`.
- The first PR in a release cycle creates it.
- Later PRs update that same file in place.
- The release workflow validates it, appends a canonical
  `dispatch-update` block to `release-notes/current.md`, then removes the JSON
  file before pushing the release commit.

## Schema

The file uses the same flat `AssistedUpdateMetadata` schema the runtime parser
already consumes:

```json
{
  "mode": "required",
  "title": "Bun runtime migration",
  "summary": "Switches the runtime from Node to Bun and changes the systemd unit shape.",
  "instructions": "1. Stop the service.\n2. Replace the runtime symlink.\n3. Restart and watch /api/v1/health.",
  "requiredChecks": [
    "expected_runtime_artifact",
    "service_entrypoint",
    "service_restarted",
    "health_endpoint",
    "version_converged"
  ],
  "rollbackGuidance": "If health does not return within 60s, restore the previous symlink and `launchctl kickstart -k`.",
  "appliesFrom": "v0.18.0"
}
```

## Merge rules

If the file already exists, rewrite it as one cohesive block using these rules:

- `mode`: never downgrade. `required > recommended > normal`.
- `appliesFrom`: keep the earlier semver.
- `requiredChecks`: union existing and new entries. Never remove a prior check.
- `title`: rewrite to cover the whole release, not just your PR.
- `summary`: rewrite as one cohesive paragraph. Do not concatenate.
- `instructions`: restructure into ordered steps. Use markdown sub-headings when
  the migrations are still logically separate.
- `rollbackGuidance`: describe how to roll back the full combined change set.

If the two migrations are not meaningfully reconcilable, do not force a merge.
Call out the conflict in the PR so one change can be deferred.

## Local validation

Run the release validator before committing:

```bash
bun bin/embed-assisted-update.ts --check-only \
  --metadata release-notes/next-assisted-update.json
```

The validator rejects:

- malformed JSON, with a line and column hint
- schema mismatches against `AssistedUpdateMetadataSchema`
- unknown `requiredChecks`
- non-semver `appliesFrom`
- literal triple-backtick fences in `title`, `summary`, `instructions`, or
  `rollbackGuidance`

## Release embedding

At release time the workflow canonicalizes the JSON and appends:

````md
```dispatch-update
{
  "mode": "required",
  ...
}
```
````

The runtime agent reads that single block from the GitHub release body. It does
not merge multiple producer entries at runtime.
