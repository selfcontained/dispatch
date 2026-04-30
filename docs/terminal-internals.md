# Terminal Internals

This doc captures the design decisions, tradeoffs, and gotchas around Dispatch's terminal experience. Most of this surfaced via investigations that went down dead ends — we're recording it so future readers don't repeat the same loops.

## Byte path

Roughly left-to-right:

```
xterm.js (web)
  ↕  WebSocket  (apps/server/src/routes/agents.ts — terminal/ws handler)
PTY adapter    (apps/server/src/shared/terminal/bun-pty.ts) — wraps Bun.Terminal
  ↕  tmux client (process running `tmux attach-session -t <sessionName>`)
tmux server (in-process, persistent across reattaches)
  ↕  agent CLI (Codex / Claude / Opencode / shell)
```

Two important properties:

- **The Fastify WS handler is a pure byte relay.** It does no escape-code parsing, no batching, no transformation. Bytes from PTY stdout go to the WebSocket as `{type:"output", data}`. Bytes from the WebSocket go to PTY stdin via `ptyProcess.write()`. The only resize-path code is `ptyProcess.resize(cols, rows)` which is a `TIOCSWINSZ` ioctl — standard PTY resize. **If you suspect a terminal bug is server-side, you're almost certainly wrong.** Look at xterm or the agent CLI first.
- **The PTY-tmux pair is the point of session persistence.** When a browser tab disconnects, only the tmux _client_ exits (not the session). New attaches spawn a fresh PTY running `tmux attach-session` against the same session, which is why state survives reloads.

The only piece of out-of-band server logic on attach is `enableTmuxMouseMode(sessionName)`, which sets `tmux set-option mouse on` once per WebSocket connect. tmux defaults to `mouse off`, and we want mouse on so wheel/touch events drive tmux's copy-mode scrollback.

## Scrolling: tmux mouse mode + copy-mode

How scroll actually works end-to-end:

1. Mouse wheel (or synthesized wheel from touch — see below) lands on `.xterm-screen`.
2. xterm.js sees the wheel event. tmux has previously sent `\x1b[?1006h\x1b[?1000h` (SGR mouse tracking enable) to xterm because `mouse on` is set, so xterm forwards the wheel as an SGR mouse event to tmux.
3. tmux receives the mouse event, drops into copy-mode automatically (because `mouse on`), and scrolls its own scrollback buffer. The agent CLI inside the pane never sees the wheel events.
4. The user sees tmux's scrollback content scroll past, the same way it would in a desktop terminal connected to the same tmux session.

For touch devices, the iPad doesn't natively send wheel events. The touch handler in `use-terminal.ts` synthesizes them: each finger drag emits `WheelEvent`s on `.xterm-screen` at 30px-per-tick granularity, and from there the path is identical to a desktop mouse wheel.

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
4. RESYNC = `detachTerminal()` + 150ms + `ensureTerminalConnected(true, true, agentId)` — same flow the manual RESYNC button uses (and same as page reload, in effect). It tears down the WebSocket and re-attaches with the new size in the URL, which spawns a fresh PTY running `tmux attach-session`. tmux emits a full screen state to the new client; xterm starts with a clean buffer.

### Why simpler approaches don't work

- **Just calling `term.resize()` more carefully** — doesn't address the stale-state-in-buffer problem.
- **`term.refresh(0, rows-1)`** — repaints the buffer; doesn't clear the stale state.
- **Server-side `tmux refresh-client`** — re-emits a frame from tmux but xterm's stale buffer still receives positioned writes targeted at cells the agent doesn't realize have garbage.
- **`fit()` debounced without the resync** — improves churn but the fundamental reflow problem remains.

### UX treatment

The 150ms detach + reconnect creates a brief disconnected/empty state that would otherwise reveal the empty-state placeholder. Two pieces of polish:

- A `resyncing` flag in `useTerminal` flips `true` when auto-RESYNC fires, `false` when the new attach reaches `connected`. Threaded through to `TerminalPane` which renders a plain `bg-background` cover with asymmetric opacity transition (`75ms` snap-in to mask the flash, `300ms` fade-out for gentle reveal). Empty state and reconnect overlay are suppressed during this window.
- `agents-view.tsx` falls back to `validatedSelectedAgentId` for `focusedAgentId` while `resyncing` is true, so `useMedia` keeps the same key and the media sidebar doesn't remount mid-resync.

## Things to remember

- **The server is innocent of buffer-state bugs.** It's a byte relay. If you're chasing a terminal corruption issue, look at xterm's reflow, the agent's redraw assumptions, or our auto-RESYNC plumbing — in that order.
- **`term.refresh()` re-renders the buffer; it doesn't fix corrupt buffer.** Easy to confuse the two.
- **`fit.fit()` reads `getComputedStyle()` of the parent** — during a CSS transition that returns the in-flight value, not the settled one. Always debounce.
- **Resize = destructive.** Don't call `term.resize()` casually. Each call rewraps the buffer and leaves state behind.
- **Codex and Claude both bind bare ↑/↓ to history navigation.** Any "scroll via fake key event" approach has to avoid them — and in practice, every modified-arrow / PgUp variant we tried also conflicts (see history below). Stick with tmux mouse-mode scroll.
- **Tmux `mouse on` is per-session and we set it on every attach.** It's idempotent and cheap. New sessions inherit `off` from tmux defaults, so don't assume it's set.
- **Don't restart the dev server during testing.** `dispatch-dev restart` and the MCP `repo_dev_restart` both tear down the postgres container and orphan agents. Backend uses `tsx watch`, so just save the file. (Memory: `feedback_dev_restart.md`.)

## History — the enhanced terminal mode (removed)

There used to be a per-user "enhanced terminal mode" setting (`enhanced_terminal` in the `settings` table). It opted into:

- `tmux mouse off` + an appended `xterm-256color:smcup@:rmcup@` override to terminal-overrides
- A `/terminal/history` REST backfill on attach
- Different touch handlers and `screenReaderMode` on xterm
- A `data-terminal-mode` attribute on `<html>` driving CSS overrides for iPad scroll behavior

The `smcup@:rmcup@` override deliberately disabled tmux's alt-screen support so that full-screen TUIs (Codex, Claude, vim) wrote their incremental redraws into main-screen scrollback — giving xterm something to scroll through locally on iPad, where tmux mouse-mode-via-server-roundtrip felt sluggish.

That trade was: noisy/incoherent scrollback (full TUI redraw history visible) vs. a more responsive iPad scroll. **It wasn't worth it.** The ripped-out feature was tested and reverted in favor of the simpler tmux-mouse-mode path documented above. Remaining settings table row (`enhanced_terminal`) is harmless dead data.

Things we tried while attempting to keep alt-screen working _and_ get usable iPad scroll, all of which failed:

- **Custom xterm wheel handler sending bare ↑/↓ keys** — xterm.js's default in alt-screen with no app mouse-mode. Codex/Claude bind these to history navigation; "scrolling" instead pulled previous messages into the input.
- **Shift+↑/↓ (`\x1b[1;2A/B`)** — Codex treats these the same as bare ↑/↓.
- **PgUp/PgDn (`\x1b[5~`/`\x1b[6~`)** — Codex doesn't scroll on these; instead enters some mode state that survives reattach.
- **SGR mouse wheel codes (`\x1b[<64;X;Y M`)** — only works if the foreground app opted into mouse tracking. Codex/Claude do not.
- **Server-side `tmux refresh-client` after resize** — addresses neither the buffer-state-mismatch problem nor the wheel-key conflict.

If we ever want a clean alt-screen + working scroll story without going back to the override hack, the realistic path is **a dedicated UI scroll affordance** (e.g., long-press to enter a scroll overlay, or a toolbar mode toggle) — bypassing the wheel/key conflict by being explicit UI rather than passthrough. Otherwise tmux mouse-mode + copy-mode is the right answer.

The previous-agent audit (`enhanced-terminal-isolation-audit.md` in dispatch media) recommended dropping the override as a cleanup. That recommendation was technically right but missed the design intent of the override; we eventually agreed and ripped the entire mode rather than just the override.

## Files of interest

| Path                                            | Role                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `apps/web/src/hooks/use-terminal.ts`            | xterm setup, resize/RESYNC, touch handlers, WS, debug actions         |
| `apps/web/src/components/app/terminal-pane.tsx` | Pane + overlays (empty / inert / resyncing / reconnect / archive)     |
| `apps/web/src/components/app/agents-view.tsx`   | `useTerminal` consumer, debug buttons, `focusedAgentId` derivation    |
| `apps/server/src/routes/agents.ts`              | WS terminal route, `enableTmuxMouseMode`                              |
| `apps/server/src/terminal/tmux-terminal.ts`     | tmux command wrappers (out-of-band: bracketed paste, session probing) |
| `apps/server/src/shared/terminal/bun-pty.ts`    | PTY adapter around `Bun.Terminal`                                     |
