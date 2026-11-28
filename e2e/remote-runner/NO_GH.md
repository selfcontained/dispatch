# Opt-in clone diagnostic without GitHub CLI

Run from the checkout root:

```sh
pnpm run test:e2e:remote-runners --no-deps --config=e2e/remote-runner/no-gh.config.ts
```

The alternate configuration selects only `no-gh.probe.ts`; the normal lane
still selects its existing 23 `*.spec.ts` cases. No CI job or default test cost
is added. Requires the same Docker and Bun setup as the normal lane. Expect
about one minute with an existing web build (the observed probe took 25.7s of
Playwright time); a fresh web build adds startup time. For an already-current
web build, the existing `E2E_SKIP_WEB_BUILD=1` option also applies.

The probe creates the lane's unauthenticated HTTPS origin and private GitHub
origin. It removes the synthetic gh executable **before** enrolling/starting
the runner and verifies gh is still absent at the end. Normal fixture helpers
may stage the fake during setup; no runner runs with it in this probe. Only
synthetic test credentials are used, and the isolated runner script removes
all containers on exit.

It records `NO_GH_PROBE` JSON and attaches results for:

1. A managed clone of the unauthenticated/public HTTPS repository.
2. A managed clone of the private repository without credentials.
3. Direct Git reads with the gh credential-helper fallback selected.
4. A managed clone of the same private repository after configuring the workload
   account's ordinary Git credential helper with the lane's synthetic credentials,
   still without gh installed.

The public clone and private clone with the workload helper must run; these
assertions preserve main's Git behavior. The unauthenticated private failure is
recorded, not pinned as an expected product restriction. A passing diagnostic
therefore does not mean the unauthenticated private clone succeeded: read its
recorded status and lastError. The gh fallback path can appear in Git config
without its binary being executed; an unauthenticated origin needs no helper,
and Git tries an existing workload helper before that fallback.

On 2026-11-23 at the integration-based triage head, the public and configured
private clones succeeded without gh. The unconfigured private clone returned
`Could not clone the repository.` Direct Git with only the absent gh helper
reported `/usr/bin/gh: not found` and `could not read Username ... terminal
prompts disabled`. `WorkloadTools.resolve` returns a fallback path rather than
throwing for an absent executable. The current managed clone path obtains that
helper in `runner.ts`'s `checkoutGitEnv`; the legacy hardened Git path obtains it
in `asWorkload`. This probe does not establish a blanket “no gh, no clone”
product restriction, and does not change product code.
