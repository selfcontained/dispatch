# Standing brief for builders (runner interface, draft PR #1540)

Read this, then `HANDOFF.md` in this folder, then only the `design.md` entries your task names. Your task message adds the scope. Where they disagree: the code wins, then your task message, then this file, then the handoff.

## The goal

Dispatch talks to every machine an agent runs on through one `Runner` interface. Local and remote runners expose the same operations; how each does the work inside is its own business. Nothing outside the runner may differ by where an agent runs.

## Rules that are not negotiable

1. **Local is origin/main exactly**, even where a difference looks safer. For every difference you find or introduce, ask "what does main do?" (`git show origin/main:<path>`) and do that. Tell the lead about every difference already on the branch.
2. **Pin main before you refactor.** Write tests on the current code that record main's behaviour (bytes, order, messages, status codes), compared with origin/main's own code. They stay unmodified and green through every later commit.
3. **Never close a gap by restricting a runner agent** (no refusing, hiding, capping, confining, dropping a tool). If the real fix is not ready, the gap stays a baseline entry and you say so.
4. **No invented behaviour, no new UI copy, no separate UX for remote.**
5. **No placement check under another name.** `isRemote`, `samePlacement`, a boolean prop, a "starts with runner://" test: all the same violation. What differs between targets is data the target carries.
6. **Build for current runners only.** No runners exist outside this effort. Do not add fallbacks, fixes or capability-gated variants for a peer that lacks a feature. Keep existing legacy-path tests green and legacy frames untouched; that code is deleted at T40.
7. **One behaviour per runner operation.** If local and remote need different internals, that is inside the runner. Presentation that main needs (ordering, messages) is applied once, outside the runner, identically for every target.
8. **If a task seems to need a restriction, new behaviour, a new API surface or a product decision: stop and ask the lead one question with the context.**

## How to work

- Your own branch, cut from the integration head your task names. Commit locally. Never touch main. Never amend, split or rebase a commit after you have reported its SHA; add commits on top.
- A move and a behaviour change are separate commits.
- Stay inside the files your task gives you. If you need another file, stop that part and tell the lead the file, lines and change.
- Boundary baseline (`scripts/runner-boundary-baseline.json`) is shrink-only: delete entries you genuinely fix in the same commit, delete or lower lines only, never edit the scanner or the restriction anchors. Do not move a check out of the scanner's sight.
- A local runner child that is absent, not ready, dies mid-call or answers `unavailable`/`unknown_outcome` falls back to the same port in process. Never a second implementation.
- No real model-backed agents, no credentials, no VMs unless your task says so. Anything needing a real runner is "unverified": list it, do not claim it.
- Never `pnpm run dev`, never port 6767, never the production `dispatch` database. Temp files outside the repo.

## Tests: what "done" requires

- **Find tests by grep for every function, route or component you change, remove or reroute, including tests that stub it.** Stale stubs have broken CI three times on this effort.
- **Web change: run the whole web unit suite** (`cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`), not a focused list.
- Server change: run every test file that exercises the code, plus `mcp-caller-parity`, `launch-admission` and `remote-runner-supervisor` if you touched MCP routes, launch or admission. Database tests need a throwaway Postgres on loopback: `/opt/homebrew/opt/postgresql@17/bin`, a free port, `unix_socket_directories=''`, test files run serially; remove it afterwards.
- UI change: drive the served app with Playwright (headless, `domcontentloaded` plus a concrete UI signal), screenshots at 390 px and desktop beside origin/main in matched state, posted as attachments; `browser_close`.
- Gates: `pnpm run check`; `pnpm run finalize:web` if `apps/web` changed; `pnpm run test:runner-packages`; `node scripts/check-runner-boundary.mjs` (report the count line); `PR_BASE_SHA=$(git rev-parse <base>) PR_HEAD_SHA=$(git rev-parse HEAD) bun scripts/ci-owner-coverage.ts` (full SHA; every added or modified file needs an owner).
- Do not run the parity oracle, the conformance lanes or the remote-runner Docker lane unless your task says so.

## Full-suite check before the lead merges

When your gates pass:
1. Merge the current integration head (`origin/agt_6500d94e4ff5/agent-4e4ff5`) into your branch (no rebase) and re-run the gates.
2. Push your branch and open a **draft** pull request against `main` titled `[runner build check] <task>`, body: "Temporary draft to run CI on a builder branch of #1540. Do not merge; the lead closes it." This is only to get the existing CI job on your branch.
3. Wait for the `ci` check. If it fails, fix it (new commits) and push again. Report only when it is green, with the PR URL.
The lead merges your branch into the integration branch and closes the draft. Never merge it yourself and never mark it ready.

## Report (one message, short)

Commit SHAs in order; the boundary count line before and after; every difference from origin/main found or introduced and what you did; what a runner agent can now do and what it still cannot; which test files you ran; the draft PR and its CI result; what is unverified. Post earlier only if blocked on a decision.
