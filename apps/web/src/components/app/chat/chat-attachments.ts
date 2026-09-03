import { normalizeUrl } from "@/components/app/create-agent-dialog-clipboard";

export type { ChatUserAttachmentInput } from "@dispatch/shared";

/** Pasted text longer than either of these is offered as a file instead. */
export const PASTE_AS_FILE_CHARS = 4_000;
export const PASTE_AS_FILE_LINES = 80;

export const PASTED_FILE_BASENAME = "pasted";

/**
 * The URL a paste amounts to when it is a lone absolute http(s) link and
 * nothing else — the case that becomes a link chip. Bare domains and prose
 * with a link in it stay inline.
 */
export function pastedLinkUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return normalizeUrl(trimmed);
}

export function isLongPaste(text: string): boolean {
  if (text.length > PASTE_AS_FILE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > PASTE_AS_FILE_LINES) return true;
    }
  }
  return false;
}

/** `pasted.txt`, then `pasted-2.txt`… whatever is not already attached. */
export function nextPastedFileName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let name = `${PASTED_FILE_BASENAME}.txt`;
  for (let n = 2; taken.has(name); n += 1) {
    name = `${PASTED_FILE_BASENAME}-${n}.txt`;
  }
  return name;
}

export function pastedTextFile(text: string, name: string): File {
  return new File([text], name, {
    type: "text/plain",
    lastModified: Date.now(),
  });
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}
