/**
 * The rail: what the stream needs from the user right now, derived from the
 * feed the Chat tab already holds (docs/design/blocks.md, step 4). Nothing
 * is fetched for it; it reads the same react-query cache `useStreamFeed`
 * fills and every `stream.entry` keeps current.
 */
import { useMemo } from "react";
import type { Block, ChatAttachment, StreamEntry } from "@dispatch/shared";

import { useRootAgentId } from "@/hooks/use-agent-tree";
import { useStreamFeed } from "@/hooks/use-stream";

/** A question or form the user has not answered yet. */
export type RailInput = Extract<Block, { kind: "question" | "form" }>;

/** A link the stream produced, newest first. */
export type RailLink = {
  url: string;
  title?: string;
  /** A pull request link, from a `pr` attachment or a PR-shaped URL. */
  pr: boolean;
  /** The block it came from, for a key and a way back to the feed. */
  blockId: string;
  at: string;
};

export type StreamRail = {
  rootId: string | null;
  /** Open inputs, oldest first: the order they were asked in. */
  inputs: RailInput[];
  links: RailLink[];
  isLoading: boolean;
};

/** How far back the links list reads; the rail is a glance, not an index. */
const LINKS_WINDOW = 200;
const LINKS_MAX = 8;

function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+/.test(url) || /\/merge_requests\/\d+/.test(url);
}

/** An agent's open question or form for people. */
export function isOpenInput(block: Block): block is RailInput {
  if (block.author.kind !== "agent" || block.toAgentId !== null) return false;
  if (block.kind === "question") return block.state?.answer === undefined;
  if (block.kind === "form") return block.state?.submission === undefined;
  return false;
}

function linksOf(block: Block): RailLink[] {
  const out: RailLink[] = [];
  const push = (url: string, title: string | undefined, pr: boolean) =>
    out.push({ url, title, pr, blockId: block.id, at: block.createdAt });
  if (block.kind === "link") {
    push(block.data.url, block.data.title, isPullRequestUrl(block.data.url));
  }
  for (const attachment of block.attachments as ChatAttachment[]) {
    if (attachment.type === "link") {
      push(attachment.url, attachment.title, isPullRequestUrl(attachment.url));
    } else if (attachment.type === "pr") {
      push(attachment.url, attachment.title, true);
    }
  }
  return out;
}

/**
 * Derive the rail from feed entries (oldest first, as the feed lists them).
 * On the root's page the whole stream counts; on a child's page only the
 * child's own blocks do, since the stream is its parent's.
 */
export function deriveStreamRail(
  entries: readonly StreamEntry[],
  agentId: string | null,
  rootId: string | null
): Pick<StreamRail, "inputs" | "links"> {
  const own = (block: Block) =>
    agentId === null ||
    agentId === rootId ||
    (block.author.kind === "agent" && block.author.agentId === agentId);
  const inputs: RailInput[] = [];
  const links: RailLink[] = [];
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.type !== "block") continue;
    const { block } = entry;
    if (!own(block)) continue;
    blocks.push(block);
    if (isOpenInput(block)) inputs.push(block);
  }
  const recent = blocks.slice(-LINKS_WINDOW);
  for (let i = recent.length - 1; i >= 0 && links.length < LINKS_MAX; i--) {
    for (const link of linksOf(recent[i]!)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
      if (links.length >= LINKS_MAX) break;
    }
  }
  return { inputs, links };
}

const EMPTY: Pick<StreamRail, "inputs" | "links"> = { inputs: [], links: [] };

/** The rail for one agent's page, live off the stream feed cache. */
export function useStreamRail(agentId: string | null): StreamRail {
  const rootId = useRootAgentId(agentId);
  const feed = useStreamFeed(rootId);
  const entries = feed.entries;
  const derived = useMemo(
    () =>
      rootId === null ? EMPTY : deriveStreamRail(entries, agentId, rootId),
    [agentId, entries, rootId]
  );
  return {
    rootId,
    inputs: derived.inputs,
    links: derived.links,
    isLoading: rootId !== null && feed.isLoading,
  };
}
