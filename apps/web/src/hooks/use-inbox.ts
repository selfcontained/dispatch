/**
 * The Inbox: requests, agent progress and results, derived from the
 * feed the Chat tab already holds (docs/design/blocks.md, step 4). Nothing
 * is fetched for it; it reads the same react-query cache `useStreamFeed`
 * fills and every `stream.entry` keeps current.
 */
import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { chatShowChildAgentsAtom } from "@/lib/store";
import type { Block, StreamEntry } from "@dispatch/shared";
import {
  INBOX_CHECKLISTS_MAX,
  INBOX_RESOURCE_POSTS_MAX,
  INBOX_RESOURCES_MAX,
  isInboxResource,
  resourcesOf,
  isInboxChecklist,
  reviewFindings,
  reviewStatus,
} from "@dispatch/shared";

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
  kind: "pr" | "preview";
  /** The block it came from, for a key and a way back to the feed. */
  blockId: string;
  at: string;
};

/** A review in the stream, newest first. */
export type InboxReview = Extract<Block, { kind: "review" }>;

export type InboxChecklist = Extract<Block, { kind: "tasks" }>;

export type Inbox = {
  rootId: string | null;
  /** Open inputs, oldest first: the order they were asked in. */
  inputs: InboxInput[];
  links: InboxLink[];
  /** Reviews the stream holds, newest first, open ones before settled ones. */
  reviews: InboxReview[];
  /** Recent agent progress, including completed lists; newest first. */
  checklists: InboxChecklist[];
  agentNames: Record<string, string>;
  isLoading: boolean;
};

const REVIEWS_MAX = 12;

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
  threadLinks: readonly Block[] = [],
  acrossChecklists: readonly Block[] = [],
  showChildAgents = true
): Pick<Inbox, "inputs" | "links" | "reviews" | "checklists"> {
  const own = (block: Block) =>
    agentId === null ||
    agentId === rootId ||
    (block.author.kind === "agent" && block.author.agentId === agentId);
  const inputs: InboxInput[] = [];
  const links: InboxLink[] = [];
  const reviews: InboxReview[] = [];
  const reviewIds = new Set<string>();
  const seen = new Set<string>();
  const asked = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "block") continue;
    const { block } = entry;
    // A review of this agent's work is addressed to it; its own reviews
    // and a person's count too. A review may be on a launch card, which
    // shows it, rather than a row of its own.
    for (const review of [block, ...(block.blocks ?? [])]) {
      if (review.kind !== "review") continue;
      if (
        !reviewIds.has(review.id) &&
        (own(review) || review.toAgentId === agentId)
      ) {
        reviewIds.add(review.id);
        reviews.unshift(review);
      }
    }
    if (block.kind === "review") continue;
    if (!own(block)) continue;
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
  reviews.sort(
    (a, b) =>
      Number(settled(a)) - Number(settled(b)) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id)
  );
  reviews.length = Math.min(reviews.length, REVIEWS_MAX);
  // Read all copies before filtering: a shown block or old paginated row
  // must not override a more recent supplemental/live version of the same ID.
  const current = new Map<string, Block>();
  const collect = (block: Block) => {
    const previous = current.get(block.id);
    if (!previous || block.updatedAt >= previous.updatedAt)
      current.set(block.id, block);
    for (const shown of block.blocks ?? []) collect(shown);
  };
  for (const entry of entries) collect(entry.block);
  for (const block of acrossChecklists) collect(block);
  for (const block of threadLinks) collect(block);
  const scope = agentId && agentId !== rootId ? agentId : showChildAgents;
  // Resolve latest copies before filtering, then bound resource posts. Generic
  // batches never consume the resource window; the server also reads direct
  // posts outside the paginated feed into threadLinks (legacy field name).
  const recent = [...current.values()]
    .filter((block) => rootId !== null && isInboxResource(block, rootId, scope))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    )
    .slice(0, INBOX_RESOURCE_POSTS_MAX);
  for (const block of recent) {
    for (const resource of resourcesOf(block)) {
      if (seen.has(resource.url)) continue;
      seen.add(resource.url);
      links.push({
        ...resource,
        pr: resource.kind === "pr",
        blockId: block.id,
        at: block.createdAt,
      });
      if (links.length >= INBOX_RESOURCES_MAX) break;
    }
    if (links.length >= INBOX_RESOURCES_MAX) break;
  }
  const checklists = [...current.values()]
    .filter(
      (block): block is InboxChecklist =>
        rootId !== null && isInboxChecklist(block, rootId, scope)
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    )
    .slice(0, INBOX_CHECKLISTS_MAX);
  return { inputs, links, reviews, checklists };
}

const EMPTY: Pick<
  Inbox,
  "inputs" | "links" | "reviews" | "checklists" | "agentNames"
> = {
  inputs: [],
  links: [],
  reviews: [],
  checklists: [],
  agentNames: {},
};

/** The Inbox for one agent's page, live off the stream feed cache. */
export function useInbox(agentId: string | null): Inbox {
  const rootId = useRootAgentId(agentId);
  const showChildAgents = useAtomValue(chatShowChildAgentsAtom);
  // Selected, not read whole: the page that holds the Inbox re-renders only
  // when the Inbox changes, not on every step of every turn in the stream.
  const select = useCallback(
    (
      entries: StreamEntry[],
      across: {
        openInputs: readonly Block[];
        threadLinks: readonly Block[];
        checklists: readonly Block[];
        agentNames: Record<string, string>;
      }
    ) => ({
      ...deriveInbox(
        entries,
        agentId,
        rootId,
        across.openInputs,
        across.threadLinks,
        across.checklists,
        showChildAgents
      ),
      agentNames: across.agentNames,
    }),
    [agentId, rootId, showChildAgents]
  );
  const feed = useStreamFeedSelect(
    rootId,
    select,
    agentId !== rootId ? (agentId ?? false) : showChildAgents
  );
  const derived = rootId === null ? EMPTY : (feed.data ?? EMPTY);
  return {
    rootId,
    inputs: derived.inputs,
    links: derived.links,
    reviews: derived.reviews,
    checklists: derived.checklists,
    agentNames: derived.agentNames,
    isLoading: rootId !== null && feed.isLoading,
  };
}
