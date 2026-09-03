/**
 * The persisted shape of an unsent chat composer draft. One per agent, in
 * localStorage (see `chatDraftAtomFamily`); the composer restores it on
 * mount and clears what it sent on a successful send.
 *
 * Files cannot survive a reload — the `File` objects only exist in memory
 * and upload at send time — so only their names are kept. A long paste that
 * became a `pasted.txt` chip keeps its text, so it comes back whole; when
 * the whole draft would exceed `CHAT_DRAFT_MAX_BYTES`, pasted bodies are
 * dropped largest-first and the chip comes back as a "needs re-attaching"
 * placeholder instead.
 */
export type ChatDraftFile = {
  name: string;
  size: number;
  mime: string;
  /**
   * Set for a pasted-text chip: the text itself, or `null` once the body was
   * dropped to fit the size cap. Absent for a picked/dropped file.
   */
  pasted?: string | null;
};

export type ChatComposerDraft = {
  text: string;
  links: string[];
  pinIds: string[];
  files: ChatDraftFile[];
};

export const EMPTY_CHAT_DRAFT: ChatComposerDraft = {
  text: "",
  links: [],
  pinIds: [],
  files: [],
};

/** Upper bound on one agent's stored draft, JSON-encoded, in UTF-8 bytes. */
export const CHAT_DRAFT_MAX_BYTES = 64 * 1024;

export function isEmptyChatDraft(draft: ChatComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.links.length === 0 &&
    draft.pinIds.length === 0 &&
    draft.files.length === 0
  );
}

/** Stored values are user-editable localStorage; anything off-shape reads as empty. */
export function isChatComposerDraft(
  value: unknown
): value is ChatComposerDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  if (typeof draft.text !== "string") return false;
  if (!Array.isArray(draft.links) || !draft.links.every(isString)) return false;
  if (!Array.isArray(draft.pinIds) || !draft.pinIds.every(isString))
    return false;
  if (!Array.isArray(draft.files) || !draft.files.every(isDraftFile))
    return false;
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isDraftFile(value: unknown): value is ChatDraftFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.name === "string" &&
    typeof file.size === "number" &&
    typeof file.mime === "string" &&
    (file.pasted === undefined ||
      file.pasted === null ||
      typeof file.pasted === "string")
  );
}

const encoder = new TextEncoder();

export function chatDraftBytes(draft: ChatComposerDraft): number {
  return encoder.encode(JSON.stringify(draft)).length;
}

/**
 * Shrinks a draft to `CHAT_DRAFT_MAX_BYTES` by dropping pasted-text bodies,
 * largest first. Typed text, links, pins and file names are never touched:
 * the message text is capped by the server's own limit, and everything else
 * is tiny. Returns the same object when nothing had to change.
 */
export function fitChatDraft(draft: ChatComposerDraft): ChatComposerDraft {
  if (chatDraftBytes(draft) <= CHAT_DRAFT_MAX_BYTES) return draft;
  const files = draft.files.map((file) => ({ ...file }));
  const candidates = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => typeof file.pasted === "string")
    .sort((a, b) => b.file.pasted!.length - a.file.pasted!.length);
  let next = { ...draft, files };
  for (const { file } of candidates) {
    file.pasted = null;
    next = { ...draft, files };
    if (chatDraftBytes(next) <= CHAT_DRAFT_MAX_BYTES) break;
  }
  return next;
}
