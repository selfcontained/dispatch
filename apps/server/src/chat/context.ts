import type { Block } from "@dispatch/shared";

export const AUTO_CONTEXT_CHARS = 4000;
export const MESSAGE_CONTENT_CHARS = 8000;

/** Public conversational content only: never launch system instructions or tool traces. */
export function messageContent(block: Block): string {
  const parts = [block.turn?.result?.text ?? block.text];
  switch (block.kind) {
    case "question":
    case "form":
    case "finding":
    case "tasks":
      parts.push(JSON.stringify({ data: block.data, state: block.state }));
      break;
    case "review":
    case "link":
      parts.push(JSON.stringify(block.data));
      break;
  }
  if (block.attachments.length) {
    parts.push(
      "Attachments (metadata only): " +
        JSON.stringify(
          block.attachments.map((a) =>
            a.type === "file"
              ? {
                  type: a.type,
                  fileName: a.fileName,
                  mimeType: a.mimeType,
                  sizeBytes: a.sizeBytes,
                }
              : a.type === "code"
                ? {
                    type: a.type,
                    language: a.language,
                    path: a.path,
                    code: a.code,
                  }
                : a
          )
        )
    );
  }
  return parts.filter(Boolean).join("\n");
}

export function messageExcerpt(
  block: Block,
  offset = 0,
  limit = MESSAGE_CONTENT_CHARS
) {
  const content = messageContent(block);
  const end = Math.min(content.length, offset + limit);
  return {
    id: block.id,
    streamId: block.streamId,
    threadId: block.threadId,
    replyTo: block.replyTo,
    author: block.author,
    kind: block.kind,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    content: content.slice(offset, end),
    offset,
    nextOffset: end < content.length ? end : null,
    totalChars: content.length,
  };
}

/** Compact delivery-only projection; full origin metadata remains in the readers. */
export function automaticExcerpt(
  block: Block,
  relation: "parent" | "thread-start" | "parent-and-thread-start",
  budget: number
): string | null {
  const content = messageContent(block);
  const serialize = (end: number) =>
    JSON.stringify({
      relation,
      id: block.id,
      author: block.author,
      kind: block.kind,
      content: content.slice(0, end),
      nextOffset: end < content.length ? end : null,
      totalChars: content.length,
    });
  // Only cut at Unicode code-point boundaries; cursors remain UTF-16 offsets.
  const offsets = [0];
  let offset = 0;
  for (const character of content) {
    offset += character.length;
    if (offset > 1800) break;
    offsets.push(offset);
  }
  const maximum = offsets[offsets.length - 1]!;
  const full = serialize(maximum);
  if (full.length <= budget) return full;
  // Truncated prefixes grow monotonically, including JSON escaping and cursor digits.
  let low = 0;
  let high = offsets.length - 2;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = serialize(offsets[middle]!);
    if (candidate.length <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
