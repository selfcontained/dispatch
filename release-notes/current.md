## What's Changed
* docs: add Updates section + sync assisted-update guidance by @selfcontained in https://github.com/selfcontained/dispatch/pull/431
* Fix round-2 recheck prompt injection flow by @selfcontained in https://github.com/selfcontained/dispatch/pull/427
* Fix two assisted-update bugs found during v0.18.9 verification by @selfcontained in https://github.com/selfcontained/dispatch/pull/432

## Migration Note
* Dispatch now runs as a compiled Bun binary in production. Existing Node-based service definitions should be updated to execute the new `dist/bun/dispatch-<version>-bun-<platform>-<arch>` binary instead of `node apps/server/dist/main.js`.
* `node-pty` and `tsx` are no longer part of the runtime path. Hosts only need Bun for source builds; a release-artifact install can run without Node.

**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.18.9...v0.18.10
