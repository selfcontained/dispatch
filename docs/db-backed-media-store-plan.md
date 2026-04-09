> **Note:** This document is a historical planning artifact. The DB-backed media store has been implemented — see the current codebase for authoritative behavior.

# DB-Backed Media Store — Implementation Plan

## Overview

Replace the filesystem-watcher-based media discovery system with a DB-backed media store. Every shared artifact (screenshots via `dispatch-share`, stream captures, simulator screenshots) gets a row in a `media` table at creation time. Media listing becomes a DB query instead of `readdir` + `fs.watch`.

## Motivation

- **Eliminate filesystem polling**: The current `fs.watch` + debounce machinery is fragile (platform-specific behavior, race conditions on rapid writes, no ordering guarantees).
- **Source tagging**: A `source` column naturally distinguishes screenshots, stream captures, and simulator captures — no filename conventions needed.
- **Single source of truth**: DB record is the authority; the file on disk is just storage.
- **Foundation for stream captures**: The Playwright streaming feature needs to save a last-frame capture when a stream ends. With a DB record, the frontend knows it's a stream capture without guessing.

## DB Migration

```sql
CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'screenshot',  -- 'screenshot' | 'stream' | 'simulator'
  size_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_agent_id ON media(agent_id);
```

No changes to the existing `media_seen` table — it continues to reference media keys (which can be derived from `file_name:created_at`).

## New API Endpoint

### `POST /api/v1/agents/:id/media`

Accepts a multipart file upload. Saves the file to the agent's media directory and inserts a DB record.

**Request**: `multipart/form-data` with fields:
- `file` (required): The image file
- `source` (optional): `"screenshot"` (default), `"stream"`, `"simulator"`

**Response**: `{ ok: true, media: { id, fileName, source, sizeBytes, createdAt, url } }`

This endpoint replaces the implicit "copy file to directory" pattern.

## Changes to `dispatch-share`

The shell script currently copies files directly to `$DISPATCH_MEDIA_DIR`. It needs to POST to the new upload endpoint instead.

```bash
# Before (filesystem copy):
cp "$SOURCE_PATH" "$dest_file"

# After (API upload):
curl -fsS -X POST \
  -F "file=@${SOURCE_PATH};filename=${safe_name}" \
  -F "source=screenshot" \
  "${API_BASE}/api/v1/agents/${AGENT_ID}/media"
```

The script still prints the file path for backward compatibility. The server returns it in the response.

## Changes to `src/server.ts`

### Remove filesystem watcher machinery

Delete:
- `mediaWatchers` Map
- `mediaDebounceTimers` Map
- `ensureMediaWatch()` function
- All `ensureMediaWatch()` call sites (agent create, agent list, SSE subscribe)

### Replace `listMediaFiles()`

```ts
// Before: readdir + stat for each file
// After: single DB query
async function listMediaFiles(agentId: string): Promise<MediaRow[]> {
  const result = await pool.query(
    `SELECT file_name, source, size_bytes, created_at
     FROM media WHERE agent_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [agentId]
  );
  return result.rows.map(row => ({
    name: row.file_name,
    source: row.source,
    size: row.size_bytes,
    updatedAt: row.created_at.toISOString(),
    url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(row.file_name)}`
  }));
}
```

### Media change notifications

The upload endpoint publishes `media.changed` via `UiEventBroker` after inserting the record — same SSE event, just triggered by the API call instead of the filesystem watcher.

### Serve media files (unchanged)

`GET /api/v1/agents/:id/media/:file` continues to serve files from disk. No change needed.

## Frontend Changes

### `MediaFile` type

```ts
export type MediaFile = {
  name: string;
  size: number;
  updatedAt: string;
  url: string;
  seen?: boolean;
  source?: "screenshot" | "stream" | "simulator";
};
```

### Media sidebar rendering

Stream captures can show a distinct label/badge (e.g., "Stream recording" vs "Shared: filename").

## Data Migration

Existing media files on disk need records inserted into the new table. A one-time migration script:

```ts
// For each agent with a media directory:
//   readdir the directory
//   For each image file, insert a media record with source='screenshot'
//   Use file mtime as created_at
```

This runs as part of the DB migration (or as a separate step after deploy).

## Stream Capture Integration

With the DB-backed store in place, saving a stream capture becomes:
1. `StreamManager.stopStream()` saves the last JPEG frame to disk
2. Server inserts a `media` record with `source: 'stream'`
3. Publishes `media.changed` SSE event
4. Frontend renders it with "Stream recording" label

## File Change Summary

| File | Change | Description |
|---|---|---|
| `src/db/migrate.ts` | Modify | Add `media` table, run data migration |
| `src/server.ts` | Modify | Add upload endpoint, remove fs watchers, update `listMediaFiles` |
| `bin/dispatch-share` | Modify | POST to API instead of filesystem copy |
| `web/src/components/app/types.ts` | Modify | Add `source` field to `MediaFile` |
| `web/src/components/app/media-sidebar.tsx` | Modify | Render source-specific labels |

## Gotchas

1. **Backward compat**: Old `dispatch-share` scripts (in running agent sessions) still copy files directly. The migration should handle discovering these files.
2. **`media_seen` keys**: Currently `name:updatedAt`. Ensure the new `created_at` timestamp produces the same key format so seen state isn't lost.
3. **File cleanup**: When an agent is deleted, `ON DELETE CASCADE` removes DB records. Files on disk still need cleanup (existing behavior via `mediaDir` removal).
4. **Upload size limits**: Fastify's default body size limit may need raising for the multipart upload endpoint.
