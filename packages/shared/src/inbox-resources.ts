import type { Block } from "./block-types.js";

/** Bound resource-bearing posts, independently of the paged feed and generic links. */
export const INBOX_RESOURCE_POSTS_MAX = 20;
export const INBOX_RESOURCES_MAX = 8;

/** Legacy PR links remain compatible; a host or LAN address never implies preview. */
export function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+/.test(url) || /\/merge_requests\/\d+/.test(url);
}

export type InboxResource = {
  url: string;
  title?: string;
  kind: "pr" | "preview";
};

export function resourcesOf(block: Block): InboxResource[] {
  const out: InboxResource[] = [];
  if (block.kind === "link" && isPullRequestUrl(block.data.url))
    out.push({ ...block.data, kind: "pr" });
  for (const attachment of block.attachments) {
    if (attachment.type === "pr" || attachment.type === "preview")
      out.push({
        url: attachment.url,
        title: attachment.title,
        kind: attachment.type,
      });
    else if (attachment.type === "link" && isPullRequestUrl(attachment.url))
      out.push({ url: attachment.url, title: attachment.title, kind: "pr" });
  }
  return out;
}

/** Preserve the Inbox's resource scope: roots read their shared stream,
 * including thread resources independent of the feed's child toggle. A
 * child's page reads only its own authored resources. Recipient routing is
 * not a privacy boundary within the same shared stream. */
export function isInboxResource(
  block: Block,
  rootId: string,
  childScope: boolean | string
): boolean {
  if (block.streamId !== rootId) return false;
  if (
    typeof childScope === "string" &&
    (block.author.kind !== "agent" || block.author.agentId !== childScope)
  )
    return false;
  return resourcesOf(block).length > 0;
}
