import {
  type ChatComposerDraft,
  fitChatDraft,
  readChatComposerDraft,
} from "@/lib/chat-draft";
import {
  CHAT_DRAFT_STORAGE_PREFIX,
  CHAT_PENDING_DRAFT_STORAGE_PREFIX,
  isPendingChatDrafts,
  type PendingChatDrafts,
} from "@/lib/store";

const activePosts = new Set<string>();
let documentClosing = false;
let pageHidden = false;
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    documentClosing = true;
    // External IDE links and cancelled navigation can fire beforeunload
    // without leaving this document. Only pagehide makes the flag durable.
    setTimeout(() => {
      if (!pageHidden) documentClosing = false;
    }, 0);
  });
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    documentClosing = true;
  });
  window.addEventListener("pageshow", () => {
    pageHidden = false;
    documentClosing = false;
  });
}
export const isChatDocumentClosing = () => documentClosing;
const lockName = (id: string) => `dispatch:chatPost:${id}`;

/** A live send owns its recovery copy across remounts and other browser tabs. */
export async function withChatPostLock(
  id: string,
  run: () => Promise<void>
): Promise<void> {
  activePosts.add(id);
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      let started = false;
      try {
        await navigator.locks.request(lockName(id), () => {
          started = true;
          return run();
        });
        return;
      } catch (error) {
        if (started) throw error;
        // Storage/privacy settings may deny Web Locks; local ownership still
        // protects a live send from recovery on a same-page remount.
      }
    }
    await run();
  } finally {
    activePosts.delete(id);
  }
}

/** Reload/close releases the send's browser lock, allowing recovery on mount. */
export async function recoverChatPost(
  id: string,
  restore: () => void
): Promise<void> {
  if (activePosts.has(id)) return;
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request(
      lockName(id),
      { ifAvailable: true },
      (lock) => {
        if (lock) restore();
      }
    );
    return;
  }
  restore();
}

export function mergeChatDrafts(
  removed: ChatComposerDraft,
  current: ChatComposerDraft
): ChatComposerDraft {
  const key = (file: ChatComposerDraft["files"][number]) =>
    `${file.name}:${file.size}:${file.mime}`;
  const currentKeys = new Set(current.files.map(key));
  return {
    text: [removed.text, current.text].filter(Boolean).join("\n\n"),
    links: [...new Set([...removed.links, ...current.links])],
    files: [
      ...removed.files.filter((file) => !currentKeys.has(key(file))),
      ...current.files,
    ],
  };
}

/** Read inside the recovery lock: storage events may lag another tab's write. */
export function readChatRecoveryState(
  agentId: string | null,
  fallbackPending: PendingChatDrafts,
  fallbackDraft: ChatComposerDraft
): { pending: PendingChatDrafts; draft: ChatComposerDraft } {
  if (agentId && typeof window !== "undefined") {
    try {
      const rawPending = window.localStorage.getItem(
        CHAT_PENDING_DRAFT_STORAGE_PREFIX + agentId
      );
      const pending: unknown = rawPending ? JSON.parse(rawPending) : {};
      const rawDraft = window.localStorage.getItem(
        CHAT_DRAFT_STORAGE_PREFIX + agentId
      );
      const persistedDraft = rawDraft
        ? readChatComposerDraft(JSON.parse(rawDraft))
        : fallbackDraft;
      return {
        pending: isPendingChatDrafts(pending) ? pending : {},
        // Our own storage snapshot may have dropped large pasted bodies.
        // Prefer the full live draft unless another tab changed the snapshot.
        draft:
          JSON.stringify(persistedDraft) ===
          JSON.stringify(fitChatDraft(fallbackDraft))
            ? fallbackDraft
            : persistedDraft,
      };
    } catch {
      /* Storage may be unavailable; retain this tab's in-memory copy. */
    }
  }
  return { pending: fallbackPending, draft: fallbackDraft };
}
