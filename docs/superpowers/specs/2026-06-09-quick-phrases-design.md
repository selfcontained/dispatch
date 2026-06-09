# Quick Phrases — Design Spec

## Overview

A "Quick Phrases" button in the terminal top rail that opens a popover with a list of saved text phrases. Clicking a phrase injects it directly into the active agent's tmux session via the server-side bracketed-paste API. Phrases are stored in the database (global, not per-project for now).

## Use Case

Users frequently type the same messages to agents ("yes", "continue", "looks good", "try a different approach"). Quick phrases turn these into one-click actions.

## Architecture

### Database

**New table: `quick_phrases`**

| Column       | Type                                 | Notes                     |
| ------------ | ------------------------------------ | ------------------------- |
| `id`         | `uuid`                               | PK, generated client-side |
| `text`       | `text NOT NULL`                      | The phrase content        |
| `sort_order` | `integer NOT NULL DEFAULT 0`         | For future reordering     |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |                           |

Migration: `0028_quick-phrases.sql`

### Server

**New file: `apps/server/src/db/quick-phrases.ts`**

CRUD functions following the `personalities.ts` pattern:

- `listQuickPhrases(pool)` → `QuickPhrase[]` ordered by `sort_order ASC, created_at ASC`
- `createQuickPhrase(pool, { text })` → `QuickPhrase`
- `deleteQuickPhrase(pool, id)` → `void`

**New file: `apps/server/src/routes/quick-phrases.ts`**

| Method   | Path                        | Body               | Response                     |
| -------- | --------------------------- | ------------------ | ---------------------------- |
| `GET`    | `/api/v1/quick-phrases`     | —                  | `{ phrases: QuickPhrase[] }` |
| `POST`   | `/api/v1/quick-phrases`     | `{ text: string }` | `{ phrase: QuickPhrase }`    |
| `DELETE` | `/api/v1/quick-phrases/:id` | —                  | `204`                        |

**New endpoint on existing agent terminal routes: `apps/server/src/routes/agents/terminal-routes.ts`**

| Method | Path                                 | Body               | Response |
| ------ | ------------------------------------ | ------------------ | -------- |
| `POST` | `/api/v1/agents/:id/terminal/inject` | `{ text: string }` | `204`    |

The inject endpoint:

1. Calls `agentManager.getTerminalAccess(id)` to get the tmux session name
2. Creates a `TmuxTerminal` and calls `sendCommand(text)` (bracketed paste + Enter)
3. Returns 204 on success, 409 if no active tmux session

This reuses the exact same `TmuxTerminal.sendCommand()` path used by `dispatch_send_message`, auto-rename, and persona review injection.

### Frontend

**New file: `apps/web/src/components/app/quick-phrases-button.tsx`**

`QuickPhrasesButton` component:

- Renders a `MessageSquare` (lucide) icon button matching the existing rail button style (`size="icon"`, `variant="ghost"`)
- Opens a shadcn `Popover` on click
- Popover content:
  - Header: "Quick Phrases" title
  - List of saved phrases — each is a clickable row that calls `POST /api/v1/agents/:id/terminal/inject`
  - Each row has a delete button (X icon) on hover
  - Bottom: text input + add button to create new phrases
  - Empty state: "No phrases yet — add one below"
- After injecting, the popover closes and the terminal re-focuses

**Props:**

- `agentId: string` — the currently focused agent
- `connState: ConnState` — to check the session is connected

**Data fetching:**

- `useQuery` for `GET /api/v1/quick-phrases` (staleTime can be generous — phrases rarely change)
- `useMutation` for create and delete, with query invalidation on success

**Placement in `agents-view.tsx`:**

The button renders in the top-left rail area, adjacent to the existing sidebar toggle. It appears only when:

1. There is a focused agent with an active session (`hasActiveAgent`)
2. The terminal connection is live (`connState === "connected"`)

Layout: the existing sidebar toggle is wrapped in `absolute left-3 top-3`. The quick phrases button sits right of it. When the sidebar is open (toggle hidden), the quick phrases button still shows in the same `left-3 top-3` area since it's independently useful.

## Constraints

- Phrase text is capped at 1000 characters (server-side validation).
- No duplicate detection — users can add the same phrase twice if they want.
- The inject endpoint sanitizes input via `TmuxTerminal.sendCommand()` which strips bracketed-paste escape sequences.
- No optimistic updates needed — the list is small and mutations are fast.

## Out of Scope

- Per-project phrases (future)
- Phrase reordering UI (the `sort_order` column is there for later)
- Keyboard shortcuts for phrases
- Phrase categories/folders
