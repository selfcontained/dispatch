import type { Block, SharedMessagePresentation } from "@dispatch/shared";
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
    case "task":
      data = { taskId: block.data.taskId };
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
    labels?: { sharer: string; originalAuthor: string; source: string };
    sourceLocation?: { streamId: string; threadId: string | null };
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

/** UI-only hydration. Do not use this projection as agent-readable context or access authority. */
export async function attachMessageShares(db: Queryable, blocks: Block[]) {
  if (!blocks.length) return;
  const result = await db.query<MessageShare>(
    "SELECT * FROM message_shares WHERE notification_id = ANY($1::uuid[])",
    [blocks.map((block) => block.id)]
  );
  const byId = new Map(
    result.rows.map((share) => [share.notification_id, share])
  );
  for (const block of blocks) {
    // Never trust a similarly named property in authored block data.
    delete block.sharedMessage;
    const share = byId.get(block.id);
    if (
      !share ||
      block.author.kind !== "agent" ||
      block.author.agentId !== share.sharer_id ||
      block.toAgentId !== share.recipient_id
    )
      continue;
    const { message, question, labels } = share.snapshot;
    const presentation: SharedMessagePresentation = {
      id: share.id,
      sourceId: share.source_id,
      ...(share.snapshot.sourceLocation
        ? { sourceLocation: share.snapshot.sourceLocation }
        : {}),
      sharedAt: share.created_at.toISOString(),
      sharer: labels?.sharer ?? "Sharing agent",
      originalAuthor:
        labels?.originalAuthor ??
        (message.author.kind === "user" ? "User" : "Original agent"),
      source: labels?.source ?? "Original conversation",
      message: {
        text: message.text,
        kind: message.kind,
        data: message.data,
        attachments: message.attachments,
      },
      question: question
        ? {
            text: question.text,
            options:
              (
                question.data as {
                  options?: import("@dispatch/shared").BlockOption[];
                } | null
              )?.options ?? [],
          }
        : null,
    };
    block.sharedMessage = presentation;
  }
}
