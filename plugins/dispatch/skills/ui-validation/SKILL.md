---
name: ui-validation
description: Prove a UI change works before calling it done. Use after changing any layout, style, component, or user-facing flow — drive it in a real browser instead of trusting a static render.
---

# Validating UI changes in a browser

A UI change is not finished when it compiles. It is finished when someone has
watched it behave. In Dispatch that means driving the running app with Playwright
and handing the user screenshots they can look at.

Applies to any change to layout, styling, a component, or a user-facing flow —
including ones that "obviously can't break anything".

## The loop

1. **Run the app.** Use the repo's own dev tooling; if the repo exposes
   `repo_*` tools for it (see the `repo-tools` skill), use those rather than
   starting a server by hand.
2. **Drive the changed path**, don't just load the page.
3. **Screenshot the meaningful states.**
4. **Share them with `dispatch_share_file`** — see the `sharing` skill. A screenshot
   left on disk was never delivered.
5. **`browser_close` when done.** Leaving browsers open wastes resources,
   especially on headless machines. Close before your final status event.

## Exercise states, not renders

A static screenshot of the initial render is the weakest possible evidence. Drive
the interaction:

- **Every toggle in both directions** — opened _and_ closed, enabled _and_
  disabled. Half of layout regressions only appear on the way back.
- **Persisted state across a reload** — if something is meant to survive a
  refresh, refresh it.
- **Empty, loading, and error states**, not only the happy path.
- **Overlays and z-index.** These are a recurring source of bugs that clicks
  catch and static review misses. **A click that times out because another
  element intercepts it is a real bug, not test flakiness** — chase it rather
  than retrying with a different selector.

## Both layouts

A change scoped to one layout must be verified _unchanged_ on the other. Desktop
work that quietly reflows mobile is common and nobody notices until a user does.
A before/after pixel comparison at the other layout's viewport is cheap and
decisive.

## Waiting for readiness

**Do not use `networkidle`** on pages with SSE or WebSocket activity — the
connection never goes idle, so the wait burns its full timeout and then reports a
failure that has nothing to do with your change.

Use `domcontentloaded` (or `load`), then wait for a concrete UI-ready signal: a
specific control being visible, a piece of text appearing, a state class landing.
Wait for the thing you actually need, not for the network to go quiet.

## Capturing screenshots worth reading

- Set **`deviceScaleFactor: 2`** or higher in the browser context. 1x captures
  are unreadable once shared, and higher still is right for mobile viewports.
- **Capture before and after** when fixing something visual. Two images beat a
  paragraph describing a difference.
- Screenshots from Playwright MCP land in the repo root — **move or delete them
  before committing** so no stray files end up in the diff. Use a temp directory
  and share from there.

## Default headless

Run headless unless you specifically need to watch it. Headless is faster and
works on machines with no display.

## What to report

Say which states you exercised and share the images. "Validated in Playwright"
with nothing attached is not evidence. If something is still unverified — a state
you could not reach, a viewport you did not test — say so explicitly rather than
letting the screenshots imply full coverage.
