# Assisted Update Authoring

> **Preferred path (CRU-146):** add an append-only manifest under
> `update-migrations/` instead of editing `release-notes/next-assisted-update.json`.
> See [Migration manifests](#migration-manifests-preferred) below. The legacy
> single-block JSON flow described after that is kept only for transitional
> compatibility while in-flight gates roll forward.

## Migration manifests (preferred)

Persistent install-update migrations live as YAML files under
`update-migrations/` at the repo root. They are append-only across release
history, ship inside the release tarball, and are evaluated per-install: the
runtime downloads the target tarball on "Check for Updates", extracts the
migration manifests, and gates assisted update based on which IDs the local
install hasn't applied yet.

### File layout

```
update-migrations/
  0001-bun-cutover.yaml
  0002-...yaml
```

- Filenames must match `<NNNN>-<id>.yaml` where `<NNNN>` is a zero-padded
  numeric ordering prefix and `<id>` is lowercase letters, digits, and hyphens.
- The `id` field inside the file must match the `<id>` in the filename and is
  the stable handle the runtime persists in `~/.dispatch/applied-migrations.json`.
- Once a manifest has shipped in a tagged release **never** rename, delete, or
  re-number it — that breaks "already applied" bookkeeping on installs that
  ran it.

### Schema (V1)

```yaml
id: bun-cutover
title: Bun runtime cutover
summary: >
  One paragraph explaining what the migration does and why.

alreadySatisfied:
  description: >
    A human-readable description of the install state that means the
    migration is already a no-op. The agent reads this first; if true it
    skips the change steps, runs validation, and marks the migration applied.

instructions:
  - Ordered step the agent should take.
  - Use as many entries as you need.
  - Skip the change steps if alreadySatisfied is true.

validation:
  requiredChecks:
    - expected_runtime_artifact
    - service_entrypoint
    - service_restarted
    - health_endpoint
    - version_converged

rollback:
  - Ordered step the agent should take to roll the migration back.
```

V1 fields only: `id`, `title`, `summary`, `alreadySatisfied.description`,
`instructions[]`, `validation.requiredChecks[]`, `rollback[]`. The parser
silently strips unknown fields rather than rejecting them, so anything outside
this list is dead weight the runtime never sees — don't add extra fields
expecting an error to catch them.

Out of scope for V1 (do **not** add): `appliesFrom`/version ranges, install-fact
predicates, supersession or dependency edges, machine-executable step DSLs.

### Run semantics

- The runtime evaluates pending migrations against the **target** release.
  Skipped releases work naturally because newer targets include older
  manifests in their tarball.
- A run sees one ordered plan covering every pending migration. The framework
  runs the union of every `validation.requiredChecks` after the agent reports
  `validate`. **All-or-nothing**: if every check passes, every pending ID is
  marked applied; if any check fails, none are.
- `requiredChecks` entries must come from the canonical set in
  `apps/server/src/release-metadata.ts` (`REQUIRED_CHECK_NAMES`). Adding new
  check names is a separate code change in `apps/server/src/release-checks.ts`.

## Legacy single-block metadata (transitional)

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
