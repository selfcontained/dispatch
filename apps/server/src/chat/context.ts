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
