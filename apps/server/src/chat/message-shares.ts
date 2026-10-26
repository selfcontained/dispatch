import type { Block } from "@dispatch/shared";
import type { Queryable } from "./store.js";

/** Only the exact block's public content, never turn internals, related findings or ask state. */
export function sharedMessageSnapshot(block: Block) {
  let data: unknown = null;
  switch (block.kind) {
    case "question":
      data = {
        options: block.data.options,
        allowFreeform: block.data.allowFreeform,
      };
      break;
    case "form":
      data = {
        title: block.data.title,
        fields: block.data.fields,
        submitLabel: block.data.submitLabel,
      };
      break;
    case "review":
      data = { summary: block.data.summary };
      break;
    case "finding":
      data = {
        severity: block.data.severity,
        title: block.data.title,
        body: block.data.body,
        path: block.data.path,
        line: block.data.line,
      };
      break;
    case "link":
      data = { url: block.data.url, title: block.data.title };
      break;
    case "tasks":
      data = { items: block.data.items };
      break;
  }
  return {
    id: block.id,
    author: block.author,
    kind: block.kind,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    text: block.text,
    data,
    attachments: block.attachments,
    ...(block.kind === "finding" || block.kind === "tasks"
      ? { state: block.state }
      : {}),
  };
}

export type MessageShare = {
  id: string;
  source_id: string;
  sharer_id: string;
  recipient_id: string;
  project_id: string;
  notification_id: string;
  snapshot: {
    message: ReturnType<typeof sharedMessageSnapshot>;
    question: ReturnType<typeof sharedMessageSnapshot> | null;
  };
  created_at: Date;
};

export async function loadMessageShare(db: Queryable, id: string) {
  return (
    (
      await db.query<MessageShare>(
        "SELECT * FROM message_shares WHERE id = $1",
        [id]
      )
    ).rows[0] ?? null
  );
}
