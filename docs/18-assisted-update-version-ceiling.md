# Assisted-update version ceiling (`appliesUpTo`)

Design notes for an extension to the assisted-update metadata schema. Not yet
implemented. Captured as a follow-up to PR #434, where the gap surfaced.

## The gap

`AssistedUpdateMetadata` (see `release-notes/AUTHORING.md` and
`apps/server/src/release-metadata.ts`) currently exposes one version knob:

- **`appliesFrom`** — a semver **floor**. The runtime gate
  (`isAssistedUpdateRequired` in `release-metadata.ts:172`) returns `true` when
  `currentTag >= appliesFrom`. Older installs are presumed to take a different
  path (manual reinstall, out of support, etc.).

Everything in the schema is target-release-keyed: the runtime only ever
consults the metadata embedded on the release the user is updating **to**. If a
release does not carry assisted-update metadata, the gate falls through to the
generic one-click path no matter what the **previous** release said.

## Why a single floor is not enough

Consider a multi-release window where one release in the middle is the
runtime-migration release:

| Release  | What changes                    | Assisted metadata                |
| -------- | ------------------------------- | -------------------------------- |
| v0.18.10 | last Node-era release           | none                             |
| v0.18.11 | Bun runtime cutover (breaking)  | required, `appliesFrom: v0.18.0` |
| v0.18.12 | bug-fix on top of Bun (this PR) | ???                              |

The two scenarios for v0.18.12 pull in opposite directions:

- An install on **v0.18.10** that updates straight to v0.18.12 must run the
  full Bun runtime migration. Without assisted metadata on v0.18.12 the user
  one-click-updates and the service breaks.
- An install on **v0.18.11** that updates to v0.18.12 only needs the artifact
  swap. Forcing it through the assisted flow with full Bun-cutover instructions
  is unnecessary ceremony.

`appliesFrom` is a floor, so it cannot express "trigger the assisted flow only
for installs **below** v0.18.11." Whatever floor you pick either captures both
or excludes both. The PR #434 release works around this by reusing the Bun
cutover metadata and rewording the instructions to branch on the runtime
already in place — but the gate still fires for Bun-already users, who do not
need it.

## Proposal: `appliesUpTo`

Add a complementary **ceiling** field. The gate becomes:

```ts
export function isAssistedUpdateRequired(
  metadata: AssistedUpdateMetadata | null,
  currentTag: string | null
): boolean {
  if (!metadata) return false;
  if (metadata.mode !== "required") return false;
  if (!currentTag) return true;

  if (
    metadata.appliesFrom &&
    compareSemver(currentTag, metadata.appliesFrom) < 0
  ) {
    return false;
  }
  if (
    metadata.appliesUpTo &&
    compareSemver(currentTag, metadata.appliesUpTo) > 0
  ) {
    return false;
  }
  return true;
}
```

Semantics:

- Both bounds are **inclusive** on the `currentTag` side. `appliesFrom: v0.18.0`
  - `appliesUpTo: v0.18.10` means "trigger when the install is anywhere in
    `[v0.18.0, v0.18.10]`."
- Either bound may be omitted. Omitting both reproduces today's "always trigger
  when `mode === required`" behavior.
- `appliesUpTo` without `appliesFrom` is allowed and means "trigger for
  anything at or below this version."

With this in place, v0.18.12 could carry:

```json
{
  "mode": "required",
  "appliesFrom": "v0.18.0",
  "appliesUpTo": "v0.18.10",
  "...": "Bun cutover instructions only — Bun-already installs skip the gate"
}
```

## Edge cases and open questions

- **Pre-release tags.** `compareSemver` in `release-metadata.ts:191` strips a
  leading `v` and trims at the first `-`. A `v0.18.10-rc.1` install therefore
  compares equal to `v0.18.10`. That is fine for `appliesUpTo` if we treat
  pre-releases as "the same line" as the GA tag, which matches how
  `appliesFrom` already behaves. Worth a comment in the docstring.
- **Semantic drift over time.** A ceiling encodes an assumption about the
  install topology at release time. If the engineer later cherry-picks the
  fixed artifact onto an older line, the ceiling can become wrong. Document
  that ceilings are point-in-time and should be set conservatively.
- **Validator behavior.** The validator in
  `apps/server/src/release-metadata.ts` should reject `appliesUpTo` values
  below `appliesFrom`. The check belongs in the Zod schema's `.refine` so it
  catches at author time.
- **Merge rules.** AUTHORING.md says `appliesFrom` keeps the **earlier**
  semver across merges. The dual is that `appliesUpTo` should keep the
  **later** semver — the union of the two ranges. Add this to the merge-rules
  table.
- **Display.** The assisted-update UI surfaces metadata to the operator. If a
  release carries a tight ceiling, the UI should say so (e.g., "applies to
  installs at v0.18.0–v0.18.10") so the operator understands why the gate did
  or did not fire.

## Implementation outline

1. **Schema (`apps/server/src/release-metadata.ts`).** Add `appliesUpTo` to the
   Zod `AssistedUpdateMetadataSchema`, with the same `semverPattern` regex as
   `appliesFrom`. Add a `.refine` enforcing `appliesUpTo >= appliesFrom`.
2. **Gate (`isAssistedUpdateRequired`).** Add the ceiling branch shown above.
3. **Canonicalizer (`canonicalizeAssistedUpdateMetadata`).** Persist
   `appliesUpTo` in the canonical block alongside `appliesFrom`.
4. **Tests.** Cover the four corners — both bounds set, only floor, only
   ceiling, neither — plus the rejection path for inverted bounds.
5. **Authoring (`release-notes/AUTHORING.md`).** Document the field, the
   inclusive-inclusive semantics, and the merge rule.
6. **Optional: UI.** Surface the range in the assisted-update launch screen so
   the operator sees the version window the release covers.

## Why this is a follow-up, not a blocker

The schema gap is real but narrow: it costs Bun-already users one extra round
through the assisted flow on every patch release until the gate semantics get
extended. Each individual release can mitigate by reusing the migration's
instructions and writing them so the no-op path is clearly handled (which is
what PR #434 does). The cost of shipping the ceiling is small — a Zod refine,
a single new `if`, a test sweep, and a doc update — but it touches the runtime
gating logic, which deserves its own PR with deliberate test coverage rather
than riding along with a bug fix.
