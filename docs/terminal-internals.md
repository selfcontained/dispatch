# Terminal Internals

This doc captures the design decisions, tradeoffs, and gotchas around Dispatch's terminal experience. Most of this surfaced via investigations that went down dead ends — we're recording it so future readers don't repeat the same loops.

## Byte path

Roughly left-to-right:

```
xterm.js (web)
  ↕  WebSocket  (apps/server/src/routes/agents.ts:1008-1112)
PTY adapter    (apps/server/src/shared/terminal/bun-pty.ts) — wraps Bun.Terminal
  ↕  tmux client (process running `tmux attach-session -t <sessionName>`)
tmux server (in-process, persistent across reattaches)
  ↕  agent CLI (Codex / Claude / Opencode / shell)
```

Two important properties:

- **The Fastify WS handler is a pure byte relay.** It does no escape-code parsing, no batching, no transformation. Bytes from PTY stdout go to the WebSocket as `{type:"output", data}`. Bytes from the WebSocket go to PTY stdin via `ptyProcess.write()`. The only resize-path code is `ptyProcess.resize(cols, rows)` which is a `TIOCSWINSZ` ioctl — standard PTY resize. **If you suspect a terminal bug is server-side, you're almost certainly wrong.** Look at xterm or the agent CLI first.
- **The PTY-tmux pair is the point of session persistence.** When a browser tab disconnects, only the tmux _client_ exits (not the session). New attaches spawn a fresh PTY running `tmux attach-session` against the same session, which is why state survives reloads.

## Terminal modes (`legacy` / `enhanced`)

The `enhanced_terminal` setting toggles a per-session mode. Stored in the `settings` table; UI in `settings-pane.tsx`; resolution in `apps/server/src/routes/agents.ts:217-231` (`resolveTerminalSessionMode`).

Differences:

| Layer                                  | Legacy                            | Enhanced                                               |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Tmux `mouse` option                    | `on`                              | `off`                                                  |
| Tmux `terminal-overrides`              | (untouched)                       | appends `xterm-256color:smcup@:rmcup@`                 |
| `/terminal/history` backfill on attach | not requested                     | requested (≤ 400 lines, see `TERMINAL_BACKFILL_LINES`) |
| Touch handler                          | dispatches synthetic wheel events | scrolls xterm buffer directly                          |
| xterm `screenReaderMode` (touch)       | `true`                            | `false`                                                |
| `<html data-terminal-mode>` attr       | `legacy`                          | `enhanced`                                             |
| `terminal-touch-island` class on pane  | not applied                       | applied                                                |

Everything else — the tmux session, the PTY, the WebSocket protocol, reconnect logic, the xterm instance, scrollback size — is **shared**. The two modes are not isolated runtimes; they're a set of branches stacked on a single shared pipeline.

### Mode resolution gotchas

- Once an agent's tmux session has been touched by enhanced mode, it stays enhanced server-side even after the user toggles the setting OFF. `resolveTerminalSessionMode` checks cache → detect-from-tmux-state → preferred, and detection wins over preferred. Workaround: kill the agent's tmux session and start fresh, or manually unset the override and `mouse on` it.
- `configureTerminalSessionMode("legacy")` only sets `mouse on`. It does not remove the enhanced override from `terminal-overrides`. So even if you reach the legacy branch on an already-enhanced session, alt-screen stays disabled.
- `terminalSessionModeCache` is per-process. A server restart clears it but detection re-runs immediately and re-confirms the stuck state from disk (tmux options).
- The frontend reads the global setting via `useEnhancedTerminal()` and decides locally about backfill / touch handler / screen-reader mode. The backend resolves per-session. They can disagree, producing 409s on `/terminal/history` (frontend on, backend off) or silently-skipped backfills (frontend off, backend on).

## The `smcup@:rmcup@` override (the deliberate hack)

This is the load-bearing weird thing in enhanced mode. **Do not remove it without reading this section.** The previous-agent audit doc in dispatch media (`enhanced-terminal-isolation-audit.md`) recommends dropping it; that recommendation is wrong in context.

### What it does

`xterm-256color:smcup@:rmcup@` deletes the `smcup` and `rmcup` capabilities from tmux's view of the terminal. Those are the escape sequences that swap into and out of the alternate screen buffer — every full-screen TUI uses them (Codex, Claude CLI, vim, less, htop, fzf).

With alt-screen disabled:

- TUI sends `smcup` → tmux drops it silently → terminal stays on main screen
- Every TUI redraw lands directly in main-screen + scrollback
- Result: scrollback fills with the TUI's full incremental render history (collapsed→expanded animations, intermediate spinner states, every frame)
- Looks "expanded and noisy" — the user sees stuff that was meant to be discarded on `rmcup`

### Why we keep it anyway

It's the **only mechanism** that gives users a working scroll experience on iPad and desktop in enhanced mode. The path:

1. tmux mouse=off → tmux ignores wheel events
2. Wheel events reach xterm
3. With alt-screen _off_, xterm has main-screen scrollback to scroll into
4. Touch (iPad) and mouse wheel (desktop) both scroll xterm's local scrollback successfully

If we restore alt-screen (drop the override):

1. xterm in alt-screen has empty main-screen scrollback (TUI never wrote there)
2. Mouse wheel default behavior in alt-screen: xterm.js translates wheel → bare ↑/↓ arrow keys
3. **Codex and Claude both bind ↑ to "edit previous message", ↓ to message navigation**
4. So scrolling silently mangles the user's input field instead of scrolling

The trade is: noisy scrollback (current) vs. completely broken scroll affordance + input mangling (without override). Current is the lesser evil.

### Things that don't fix it

We tested all of these. None work:

- **`tmux refresh-client` after resize.** Forces tmux to re-emit a frame, but doesn't address xterm buffer state mismatches and doesn't help the wheel→arrow problem at all. Adds two `tmux` shell-outs per resize for no benefit.
- **Custom xterm wheel handler sending Shift+↑/↓ (`\x1b[1;2A/B`).** Codex treats these the same as bare ↑/↓. Same input mangling.
- **Custom xterm wheel handler sending PgUp/PgDn (`\x1b[5~`/`\x1b[6~`).** Codex doesn't scroll on these; instead enters some mode state that survives reattach (Codex's UI state lives in its tmux process, not in the browser). Likely also true of Claude.
- **Custom xterm wheel handler sending SGR mouse wheel codes (`\x1b[<64;X;Y M`).** xterm.js already does this _automatically_ when an alt-screen app has enabled mouse tracking. Codex/Claude do not request mouse mode in their alt-screens, so xterm falls back to wheel→arrow translation.
- **Wiring the iPad bottom-toolbar arrow buttons** — they send bare ↑/↓ which collides with Codex/Claude bindings same as wheel-to-arrow translation. Could potentially be repurposed but you're back to needing some app-level cooperation.

### Realistic future paths

If we ever want clean alt-screen + working scroll:

1. **A dedicated "scroll mode" UI affordance** on iPad and desktop. Long-press / button to enter an overlay that scrolls. Bypasses the wheel/arrow conflict by being explicit UI, not key passthrough. Most viable path.
2. **Codex / Claude opting into mouse tracking** in their alt-screens. Out of our control.
3. **A tee mechanism** that captures alt-screen frames into a separate buffer the user can review. Significant new infra.

## Resize handling

### The bug we fixed

Symptom: after a resize (sidebar toggle, window resize, rotation), the terminal renders fine for static content. Then as soon as new bytes arrive — typed echo, agent output streaming — content gets garbled. Page reload fixes it.

Why: `term.resize()` is destructive — xterm reflows the existing buffer at new cols/rows. It also leaves stale state behind (cursor saves from `ESC 7`, scroll regions, app modes, scrollback rows wrapped at the old cols). The agent's incremental redraw after `SIGWINCH` uses absolute cursor positioning that assumes the screen is "blank, redraw from scratch" — but xterm's buffer still has the stale state. Subsequent positioned writes land in cells the agent thought it cleared.

### The fix: auto-RESYNC

In `apps/web/src/hooks/use-terminal.ts`, `requestFit` is a trailing-debounced (300ms) size-change detector:

1. ResizeObserver and CSS transitions fire many size changes per visual settle.
2. Each fires `requestFit`, which clears any pending timer and sets a new 300ms one.
3. When 300ms passes with no further size change, the timer fires:
   - Calls `fit.proposeDimensions()` (read-only — reads parent computed style)
   - If proposed cols/rows ≠ current, triggers a full RESYNC
4. RESYNC = `detachTerminal()` + 150ms + `ensureTerminalConnected(true, true, agentId)` — same flow the manual RESYNC button uses (and same as page reload, in effect).

A page reload mirrors RESYNC because it creates a new xterm with a clean buffer, then re-pulls the current viewport from tmux via `/terminal/history`. RESYNC does the same in-place.

### Why simpler approaches don't work

- **Just calling `term.resize()` more carefully** — doesn't address the stale-state-in-buffer problem.
- **`term.refresh(0, rows-1)`** — repaints the buffer; doesn't clear the stale state.
- **Server-side `tmux refresh-client`** — re-emits a frame from tmux but xterm's stale buffer still receives positioned writes targeted at cells the agent doesn't realize have garbage.
- **`fit()` debounced without the resync** — improves churn but the fundamental reflow problem remains.

### UX treatment

The 150ms detach + reconnect creates a brief disconnected/empty state that would otherwise reveal the empty-state placeholder. Two pieces of polish:

- A `resyncing` flag in `useTerminal` flips `true` when auto-RESYNC fires, `false` when the new attach reaches `connected`. Threaded through to `TerminalPane` which renders a plain `bg-background` cover with asymmetric opacity transition (`75ms` snap-in to mask the flash, `300ms` fade-out for gentle reveal). Empty state and reconnect overlay are suppressed during this window.
- `agents-view.tsx` falls back to `validatedSelectedAgentId` for `focusedAgentId` while `resyncing` is true, so `useMedia` keeps the same key and the media sidebar doesn't remount mid-resync.

### Backfill size

`TERMINAL_BACKFILL_LINES = 400` (was 1200). xterm scrollback is configured at 1000 lines, so requesting more than that throws content away on write. 400 is roughly 8 screens worth of agent output and matches what's typically useful.

## Debug buttons

The agents sidebar header (`SidebarShell`) has a `headerActions` slot. `agents-view.tsx` populates it with three small text buttons next to the DISPATCH logo:

- **FIT** — `fitAddon.fit()` + `sendResize()`. Bypasses the 300ms debounce.
- **RFSH** — `term.refresh(0, term.rows - 1)`. Repaints visible buffer rows. Only useful for stale-glyph artifacts; won't fix corrupted buffer state.
- **RESYNC** — `detachTerminal()` + 150ms + `ensureTerminalConnected(true, true, connectedAgentId)`. The actual buffer-state fix.

Each button flashes blue with `✓` for 400ms on click — important for iPad where there's no console to verify the click registered.

## Things to remember

- **The server is innocent of buffer-state bugs.** It's a byte relay. If you're chasing a terminal corruption issue, look at xterm's reflow, the agent's redraw assumptions, or our auto-RESYNC plumbing — in that order.
- **`term.refresh()` re-renders the buffer; it doesn't fix corrupt buffer.** Easy to confuse the two.
- **`fit.fit()` reads `getComputedStyle()` of the parent** — during a CSS transition that returns the in-flight value, not the settled one. Always debounce.
- **Resize = destructive.** Don't call `term.resize()` casually. Each call rewraps the buffer and leaves state behind.
- **Codex and Claude both bind bare ↑/↓ to history navigation.** Any scroll-via-key approach has to avoid them.
- **`smcup@:rmcup@` is load-bearing.** Removing it visibly cleans up scrollback but breaks the only working scroll affordance on iPad/desktop in enhanced mode.
- **Tmux session state is sticky.** A user setting toggle doesn't reconfigure live sessions. Detection wins over preference.
- **Don't restart the dev server during testing.** `dispatch-dev restart` and the MCP `repo_dev_restart` both tear down the postgres container and orphan agents. Backend uses `tsx watch`, so just save the file. (Memory: `feedback_dev_restart.md`.)

## Files of interest

| Path                                            | Role                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `apps/web/src/hooks/use-terminal.ts`            | xterm setup, resize/RESYNC, touch handlers, WS, debug actions         |
| `apps/web/src/components/app/terminal-pane.tsx` | Pane + overlays (empty / inert / resyncing / reconnect / archive)     |
| `apps/web/src/components/app/agents-view.tsx`   | `useTerminal` consumer, debug buttons, `focusedAgentId` derivation    |
| `apps/web/src/components/app/sidebar-shell.tsx` | `headerActions` slot for debug buttons                                |
| `apps/web/src/hooks/use-enhanced-terminal.ts`   | Frontend setting hook                                                 |
| `apps/server/src/routes/agents.ts`              | WS terminal route, backfill endpoint, mode resolution + configuration |
| `apps/server/src/terminal/tmux-terminal.ts`     | tmux command wrappers (out-of-band: `capture-pane`, bracketed paste)  |
| `apps/server/src/shared/terminal/bun-pty.ts`    | PTY adapter around `Bun.Terminal`                                     |
