> **Note:** This document is a historical planning artifact. Stream capture on end has been implemented — see the current codebase for authoritative behavior.

# Stream Capture on End — Implementation Plan

## Overview

When a Playwright browser stream ends, save the last frame as a JPEG in the agent's media directory and record it via the DB-backed media store (see `db-backed-media-store-plan.md`). The saved frame appears in the media sidebar as a "Stream recording" — a visual record that a stream session happened.

## Prerequisite

This plan depends on the DB-backed media store being in place. The media store provides:
- A `media` table with a `source` column to tag the capture as `"stream"`
- An upload/insert pathway that publishes `media.changed` SSE events
- Frontend support for rendering source-specific labels

## Changes to `src/stream-manager.ts`

Add an `onStreamEnd` callback that fires with the last frame buffer before cleanup:

```ts
type OnStreamEnd = (agentId: string, lastFrame: Buffer) => void;

export class StreamManager {
  constructor(
    onStateChange: OnStateChange,
    onStreamEnd?: OnStreamEnd
  ) { ... }
}
```

In `stopStream()`, before clearing `lastFrame`:

```ts
if (session.lastFrame && this.onStreamEnd) {
  try {
    this.onStreamEnd(agentId, session.lastFrame);
  } catch {
    // Best-effort; don't block cleanup
  }
}
session.lastFrame = null;
```

## Changes to `src/server.ts`

Pass the `onStreamEnd` callback when constructing `StreamManager`:

```ts
const streamManager = new StreamManager(
  (agentId, event) => { /* existing SSE publish */ },
  async (agentId, lastFrame) => {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) return;

    const mediaDir = resolveMediaDir(agentId, agent.mediaDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `stream-capture-${timestamp}.jpg`;

    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, fileName), lastFrame);

    // Insert DB record with source='stream'
    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes)
       VALUES ($1, $2, 'stream', $3)`,
      [agentId, fileName, lastFrame.length]
    );

    uiEventBroker.publish({ type: "media.changed", agentId });
  }
);
```

## Frontend Changes

### Media sidebar

When rendering a media file where `source === "stream"`, show:
- A "Stream recording" label instead of the usual "Shared: filename" description
- Optionally a small badge or icon to visually distinguish it from screenshots

### `mediaDescription` helper

```ts
const mediaDescription = (file: MediaFile): string => {
  if (file.source === "stream") {
    return "Stream recording";
  }
  // ... existing logic
};
```

## UX Flow

1. Agent starts a Playwright stream → sidebar auto-opens with live stream preview
2. User watches live stream in sidebar or pops it out to a separate window
3. Agent (or server) stops the stream
4. Last frame is saved as `stream-capture-*.jpg` in the media directory
5. DB record inserted with `source: 'stream'`
6. SSE `media.changed` fires → sidebar refreshes
7. The capture appears at the top of the media gallery labeled "Stream recording"
8. User can click to open it in the lightbox like any other media item

## File Change Summary

| File | Change | Description |
|---|---|---|
| `src/stream-manager.ts` | Modify | Add `onStreamEnd` callback, fire before cleanup |
| `src/server.ts` | Modify | Pass callback that saves frame + inserts DB record |
| `web/src/App.tsx` | Modify | Update `mediaDescription` to handle `source` field |
| `web/src/components/app/media-sidebar.tsx` | Modify | Render stream capture badge/label |

## Sequencing

1. Merge the DB-backed media store (prerequisite)
2. Implement this plan on top
3. Both can land on the same `feature/playwright-streaming` branch
