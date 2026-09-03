/**
 * The persisted shape of an unsent chat composer draft. One per agent, in
 * localStorage (see `chatDraftAtomFamily`); the composer restores it on
 * mount and clears what it sent on a successful send.
 *
 * Files cannot survive a reload — the `File` objects only exist in memory
 * and upload at send time — so only their names are kept. A long paste that
 * became a `pasted.txt` chip keeps its text, so it comes back whole.
 *
 * What the composer holds in memory is the full draft. What reaches storage
 * is `fitChatDraft` of it: a lossy snapshot bounded to
 * `CHAT_DRAFT_MAX_BYTES` (see there for what is dropped, in what order).
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

/**
 * Appended to the text when the snapshot had to cut it, so the restored
 * draft says where it ends rather than silently trailing off.
 */
export const CHAT_DRAFT_TRUNCATED_MARKER =
  "\n[… draft cut here to fit storage]";

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

const fits = (draft: ChatComposerDraft): boolean =>
  chatDraftBytes(draft) <= CHAT_DRAFT_MAX_BYTES;

/**
 * The lossy snapshot of a draft that goes to storage: the same shape, never
 * more than `CHAT_DRAFT_MAX_BYTES` encoded, whatever the input. Cheapest
 * losses first, each step only as far as it has to go:
 *
 * 1. pasted-text bodies, largest first (the chip comes back as a "paste
 *    again" placeholder);
 * 2. links, longest first;
 * 3. the text, cut at a code-point boundary with
 *    `CHAT_DRAFT_TRUNCATED_MARKER` on the end;
 * 4. file chips and then pins, from the end — only reachable with names or
 *    ids far beyond anything the UI produces, kept so the bound holds for
 *    any input rather than any *likely* input.
 *
 * Returns the same object when nothing had to change; never mutates it.
 */
export function fitChatDraft(draft: ChatComposerDraft): ChatComposerDraft {
  if (fits(draft)) return draft;
  let next = dropPastedBodies(draft);
  if (fits(next)) return next;
  next = dropLinks(next);
  if (fits(next)) return next;
  next = truncateText(next);
  if (fits(next)) return next;
  next = { ...next, files: [] };
  if (fits(next)) return next;
  return { ...next, pinIds: [] };
}

function dropPastedBodies(draft: ChatComposerDraft): ChatComposerDraft {
  const files = draft.files.map((file) => ({ ...file }));
  const candidates = files
    .filter((file) => typeof file.pasted === "string")
    .sort((a, b) => b.pasted!.length - a.pasted!.length);
  const next = { ...draft, files };
  for (const file of candidates) {
    file.pasted = null;
    if (fits(next)) break;
  }
  return next;
}

function dropLinks(draft: ChatComposerDraft): ChatComposerDraft {
  const byLength = draft.links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => b.link.length - a.link.length);
  const dropped = new Set<number>();
  let next = draft;
  for (const { index } of byLength) {
    dropped.add(index);
    next = { ...draft, links: draft.links.filter((_, i) => !dropped.has(i)) };
    if (fits(next)) break;
  }
  return next;
}

/**
 * Keeps the longest prefix of the text that fits with the marker appended.
 * Encoded size grows with the prefix, so a binary search finds it.
 */
function truncateText(draft: ChatComposerDraft): ChatComposerDraft {
  const { text } = draft;
  const withText = (prefix: string): ChatComposerDraft => ({
    ...draft,
    text: prefix.length > 0 ? prefix + CHAT_DRAFT_TRUNCATED_MARKER : "",
  });
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(withText(text.slice(0, mid)))) low = mid;
    else high = mid - 1;
  }
  // Never end on the first half of a surrogate pair.
  if (low > 0 && isHighSurrogate(text.charCodeAt(low - 1))) low -= 1;
  return withText(text.slice(0, low));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
