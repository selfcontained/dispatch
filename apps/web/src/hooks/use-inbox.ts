/**
 * The Inbox: what the stream needs from the user right now, derived from the
 * feed the Chat tab already holds (docs/design/blocks.md, step 4). Nothing
 * is fetched for it; it reads the same react-query cache `useStreamFeed`
 * fills and every `stream.entry` keeps current.
 */
import { useCallback } from "react";
import type { Block, ChatAttachment, StreamEntry } from "@dispatch/shared";
import { reviewFindings, reviewStatus } from "@dispatch/shared";

import { useRootAgentId } from "@/hooks/use-agent-tree";
import { useStreamFeedSelect } from "@/hooks/use-stream";

/** A question or form the user has not answered yet. */
export type InboxInput = Extract<Block, { kind: "question" | "form" }>;

/** A link the stream produced, newest first. */
export type InboxLink = {
  url: string;
  title?: string;
  /** A pull request link, from a `pr` attachment or a PR-shaped URL. */
  pr: boolean;
  /** The block it came from, for a key and a way back to the feed. */
  blockId: string;
  at: string;
};

/** A review in the stream, newest first. */
export type InboxReview = Extract<Block, { kind: "review" }>;

export type Inbox = {
  rootId: string | null;
  /** Open inputs, oldest first: the order they were asked in. */
  inputs: InboxInput[];
  links: InboxLink[];
  /** Reviews the stream holds, newest first, open ones before settled ones. */
  reviews: InboxReview[];
  isLoading: boolean;
};

const REVIEWS_MAX = 12;

/** How far back the links list reads; the Inbox is a glance, not an index. */
const LINKS_WINDOW = 200;
const LINKS_MAX = 8;

function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+/.test(url) || /\/merge_requests\/\d+/.test(url);
}

/** An agent's open question or form for people. */
export function isOpenInput(block: Block): block is InboxInput {
  if (block.author.kind !== "agent" || block.toAgentId !== null) return false;
  const canceled = (
    block.state as { cancellation?: unknown } | null | undefined
  )?.cancellation;
  if (canceled !== undefined) return false;
  if (block.kind === "question") return block.state?.answer === undefined;
  if (block.kind === "form") return block.state?.submission === undefined;
  return false;
}

function linksOf(block: Block): InboxLink[] {
  const out: InboxLink[] = [];
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
 * Derive the Inbox from feed entries (oldest first, as the feed lists them).
 * On the root's page the whole stream counts; on a child's page only the
 * child's own blocks do, since the stream is its parent's.
 */
export function deriveInbox(
  entries: readonly StreamEntry[],
  agentId: string | null,
  rootId: string | null,
  openInputs: readonly Block[] = [],
  threadLinks: readonly Block[] = []
): Pick<Inbox, "inputs" | "links" | "reviews"> {
  const own = (block: Block) =>
    agentId === null ||
    agentId === rootId ||
    (block.author.kind === "agent" && block.author.agentId === agentId);
  const inputs: InboxInput[] = [];
  const links: InboxLink[] = [];
  const reviews: InboxReview[] = [];
  const seen = new Set<string>();
  const blocks: Block[] = [];
  const asked = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "block") continue;
    const { block } = entry;
    // A review of this agent's work is addressed to it; its own reviews
    // and a person's count too. A review may be on a launch card, which
    // shows it, rather than a row of its own.
    for (const review of [block, ...(block.blocks ?? [])]) {
      if (review.kind !== "review") continue;
      if (own(review) || review.toAgentId === agentId) reviews.unshift(review);
    }
    if (block.kind === "review") continue;
    if (!own(block)) continue;
    blocks.push(block);
    if (isOpenInput(block)) {
      inputs.push(block);
      asked.add(block.id);
    }
  }
  // Asks made in a thread (a child asks in its own) are not rows of the
  // feed; the first page lists every open one.
  for (const block of openInputs) {
    if (asked.has(block.id) || !own(block) || !isOpenInput(block)) continue;
    inputs.push(block);
    asked.add(block.id);
  }
  inputs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const settled = (review: InboxReview) =>
    reviewStatus(reviewFindings(review)) === "resolved";
  reviews.sort((a, b) => Number(settled(a)) - Number(settled(b)));
  reviews.length = Math.min(reviews.length, REVIEWS_MAX);
  // A child's links are posted in its own thread, which the feed does not
  // list; the first page carries the newest of those. Newest first, all
  // together.
  const recent = [
    ...blocks.slice(-LINKS_WINDOW),
    ...threadLinks.filter((block) => own(block)),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (let i = recent.length - 1; i >= 0 && links.length < LINKS_MAX; i--) {
    for (const link of linksOf(recent[i]!)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
      if (links.length >= LINKS_MAX) break;
    }
  }
  return { inputs, links, reviews };
}

const EMPTY: Pick<Inbox, "inputs" | "links" | "reviews"> = {
  inputs: [],
  links: [],
  reviews: [],
};

/** The Inbox for one agent's page, live off the stream feed cache. */
export function useInbox(agentId: string | null): Inbox {
  const rootId = useRootAgentId(agentId);
  // Selected, not read whole: the page that holds the Inbox re-renders only
  // when the Inbox changes, not on every step of every turn in the stream.
  const select = useCallback(
    (
      entries: StreamEntry[],
      across: { openInputs: readonly Block[]; threadLinks: readonly Block[] }
    ) =>
      deriveInbox(
        entries,
        agentId,
        rootId,
        across.openInputs,
        across.threadLinks
      ),
    [agentId, rootId]
  );
  const feed = useStreamFeedSelect(rootId, select);
  const derived = rootId === null ? EMPTY : (feed.data ?? EMPTY);
  return {
    rootId,
    inputs: derived.inputs,
    links: derived.links,
    reviews: derived.reviews,
    isLoading: rootId !== null && feed.isLoading,
  };
}
