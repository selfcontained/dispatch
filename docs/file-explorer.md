# Workspace Files pane

Files is a read-only browser for the selected agent's effective workspace. It
supports lazy folder browsing, filename/path search, text and static image
previews, and the shared icon-only Copy and Download actions.

## Refresh behavior

Folders and selected files are fetched on demand and cached. There are no
filesystem watchers, polling loops, or automatic refetches on window focus.
Click **Refresh files and preview** to reread expanded folders and the selected
file and invalidate the filename search snapshot. If search is closed, its
snapshot is rebuilt when search is used again. Returning to Files may fetch
data again if its inactive query cache has expired.

Expanded folders, search text, the mobile browse/preview choice, and tree/search
scroll positions are remembered per agent and workspace. The selected file is
stored in the URL. Preview scroll position is not persisted.

## Browsing and keyboard access

Git workspaces hide ignored entries using Git's own rules, including negations
and tracked-file exceptions. Opening a folder checks its entries in batches;
ignored entries do not consume the visible-entry allowance.

The file tree has one keyboard tab stop. Up/Down moves between entries;
Home/End reaches the first/last entry; Page Up/Down moves roughly one viewport.
Right expands a folder or moves to its first child; Left collapses a folder or
moves to its parent. Enter or Space opens the focused file or toggles a folder.
Keyboard navigation mounts and reveals the destination even when it was outside
the virtual viewport.

## MVP limits

- A directory listing returns up to **500 visible entries**. It also has a
  **20,000-entry scan budget** and an approximately **2-second scan deadline**.
  Ignore checks have their own timeout, so these are bounded-work safeguards,
  not a strict end-to-end latency guarantee. Partial listings are marked.
- Up to **32 directories**, including the root, can be expanded at once.
- Filename search reads names only, never file contents. Its snapshot is capped
  at **20,000 paths**, **2 MiB of names**, and roughly **2 seconds** of indexing.
  At most **200 matching results** are shown, with partial/result limits labeled.
  Git indexing excludes ignored untracked files. Outside Git, the bounded folder
  walk skips common dependency/build directories and symlinks.
- Preview reads are limited to **1 MiB**. Text must be UTF-8. Images are limited
  to static PNG/JPEG with readable dimensions up to **16 megapixels**.
  Unsupported previews display a reason; they do not expose download actions.
- Text scrolls continuously; only nearby lines are mounted. Full-text Copy
  copies the loaded document. Browser Find and native selection operate only
  on mounted content; a dedicated in-file search is not included.
- Highlighting runs in a worker with a **2-second timeout**. Files over
  **262,144 text characters**, lines over **4,000 characters**, or excessive
  highlighted output fall back to plain text. Very long displayed lines are
  clipped, with full text still available through Copy/Download.
- Files is read-only; there are no rename/delete/edit operations.

## Filesystem trust boundary

Files reads with the Dispatch server's OS permissions. Path validation rejects
parent traversal and detected symlinks, and opening paths includes identity
rechecks. These checks are defense in depth, not a filesystem sandbox: a process
deliberately racing directory replacements inside the workspace can redirect a
listing or preview outside it, despite the rechecks.

This race is an accepted limitation of the local MVP, not a fixed vulnerability.
The security review found no additional read capability in the reviewed default
execution and authentication configurations. Files uses the existing HTTP API
authentication; agent-scoped MCP credentials alone do not authorize this route.
The server's no-password mode also applies to Files. Preview contents are not
automatically sent to agents, but an operator could copy outside content shown
under a misleading workspace path.

Custom runtime sandbox policies were not exhaustively verified. Do not rely on
Files to enforce a read restriction imposed on another process. Reassess this
acceptance before introducing restricted OS identities or read sandboxes,
agent-accessible Files APIs or automatic preview-to-agent context, multi-user
authorization, write operations, or share links. Those changes may require
descriptor-relative filesystem access that cannot be redirected by pathname
replacement.

## Sharing and scope

Files loads as a separate frontend chunk. Its syntax worker loads when a text
preview is opened. Files, stream fenced code blocks, and shared-file previews
use two automatic dark/light syntax palettes. Their Copy controls share the
temporary checkmark feedback component; file previews share Download controls.

Changes retains its own accessible diff palette and rendering path. Optimizing
large diffs and extracting a common file-tree component are separate follow-ups.
The preview environment's comparison-base correction is dev data only, not a
Changes renderer optimization.
