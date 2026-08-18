/**
 * Brain record shapes — the wire types the API returns and the web client
 * reads. Kept in a dependency-free module so `apps/web` can `import type` them
 * directly instead of hand-mirroring them; `store.ts` re-exports every name so
 * server-side importers are unaffected.
 */

export type BrainObject = {
  collection: string;
  name: string;
  value: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdByAgentId: string;
  updatedByAgentId: string;
};

export type BrainEvent = {
  id: string;
  collection: string;
  kind: string;
  subject: string | null;
  tags: string[];
  value: unknown;
  createdAt: string;
  agentId: string;
};

export type BrainList = {
  collection: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdByAgentId: string;
  updatedByAgentId: string;
};

/** A list as the list endpoints return it: the record plus its item count. */
export type BrainListWithItemCount = BrainList & { itemCount: number };

export type BrainListItem = {
  index: number;
  value: unknown;
  createdAt: string;
  updatedAt: string;
};

export type BrainProject = {
  repoRoot: string;
  objectCount: number;
  listCount: number;
  eventCount: number;
};

export type BrainCollectionSummary = {
  collection: string;
  objectCount: number;
  listCount: number;
  eventCount: number;
};

/** The three brain entry kinds, named as they appear in the UI and API paths. */
export type BrainEntryType = "objects" | "lists" | "events";

/** One count per entry kind, so a new kind cannot be added to only one of them. */
export type BrainCollectionDeleteResult = Record<BrainEntryType, number>;

export type BrainDeleteResult = BrainCollectionDeleteResult;

/**
 * A bulk delete covers one entry type, scoped either to a single collection or
 * to every collection in the project. `allCollections` has to be asked for by
 * name so a dropped `collection` cannot silently widen a targeted prune into a
 * project-wide one — the same reason brain_delete_events requires a collection.
 */
export type BrainEntryTypeDeleteScope =
  | { collection: string }
  | { allCollections: true };

export type BrainEventFilter = {
  collection?: string;
  kind?: string;
  subject?: string;
  tags?: string[];
  since?: string;
  until?: string;
};

/**
 * Deletes address either specific events or one collection — never both, and
 * never an unscoped filter. Expressed as a union so illegal combinations fail
 * at the call site; the store still checks what types can't say (empty ids
 * array, id cap, timestamp format).
 */
export type BrainEventDeleteSelector =
  | { ids: string[]; dryRun?: boolean }
  | (BrainEventFilter & { collection: string; dryRun?: boolean });

export type BrainAgentActivity = {
  objects: BrainObject[];
  lists: BrainListWithItemCount[];
  events: BrainEvent[];
};
