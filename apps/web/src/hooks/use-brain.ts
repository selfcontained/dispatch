import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  BrainCollectionSummary as BrainCollectionSummaryRecord,
  BrainEntryType as BrainEntryTypeRecord,
  BrainEvent as BrainEventRecord,
  BrainListItem as BrainListItemRecord,
  BrainListWithItemCount as BrainListRecord,
  BrainObject as BrainObjectRecord,
  BrainProject as BrainProjectRecord,
} from "../../../server/src/brain/types";

import { api } from "@/lib/api";

export type BrainProject = BrainProjectRecord;

export type BrainCollectionSummary = BrainCollectionSummaryRecord;

export type BrainObject = BrainObjectRecord;

export type BrainList = BrainListRecord;

export type BrainListItem = BrainListItemRecord;

/** Matches the brain entry-type segment in the bulk-delete API paths. */
export type BrainEntryType = BrainEntryTypeRecord;

export type BrainEvent = BrainEventRecord;

/**
 * Unfiltered counts for a scope. Derived so it cannot drift from the payloads
 * it is read out of; a collection summary and a project summary both carry
 * exactly these counts.
 */
export type ScopeTotals = Pick<
  BrainCollectionSummary,
  "objectCount" | "listCount" | "eventCount"
>;

const ENTRY_TYPE_COUNT_KEYS = {
  objects: "objectCount",
  lists: "listCount",
  events: "eventCount",
} as const satisfies Record<BrainEntryType, keyof ScopeTotals>;

export const BRAIN_ENTRY_TYPES = Object.keys(
  ENTRY_TYPE_COUNT_KEYS
) as BrainEntryType[];

export function scopeCount(
  totals: ScopeTotals,
  entryType: BrainEntryType
): number {
  return totals[ENTRY_TYPE_COUNT_KEYS[entryType]];
}

export function useBrainProjects(enabled = true) {
  return useQuery<BrainProject[]>({
    queryKey: ["brain", "projects"],
    queryFn: () => api<BrainProject[]>("/api/v1/brain/projects"),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useBrainCollections(repoRoot: string | null) {
  return useQuery<BrainCollectionSummary[]>({
    queryKey: ["brain", "collections", repoRoot],
    queryFn: () => {
      const params = new URLSearchParams({ repoRoot: repoRoot! });
      return api<BrainCollectionSummary[]>(
        `/api/v1/brain/collections?${params.toString()}`
      );
    },
    enabled: !!repoRoot,
    refetchOnWindowFocus: false,
  });
}

export function useBrainObjects(
  repoRoot: string | null,
  filters?: { collection?: string; prefix?: string; limit?: number }
) {
  return useQuery<BrainObject[]>({
    queryKey: ["brain", "objects", repoRoot, filters],
    queryFn: () => {
      const params = new URLSearchParams({ repoRoot: repoRoot! });
      if (filters?.collection) params.set("collection", filters.collection);
      if (filters?.prefix) params.set("prefix", filters.prefix);
      if (filters?.limit) params.set("limit", String(filters.limit));
      return api<BrainObject[]>(`/api/v1/brain/objects?${params.toString()}`);
    },
    enabled: !!repoRoot,
    refetchOnWindowFocus: false,
  });
}

export function useBrainLists(
  repoRoot: string | null,
  filters?: { collection?: string; limit?: number }
) {
  return useQuery<BrainList[]>({
    queryKey: ["brain", "lists", repoRoot, filters],
    queryFn: () => {
      const params = new URLSearchParams({ repoRoot: repoRoot! });
      if (filters?.collection) params.set("collection", filters.collection);
      if (filters?.limit) params.set("limit", String(filters.limit));
      return api<BrainList[]>(`/api/v1/brain/lists?${params.toString()}`);
    },
    enabled: !!repoRoot,
    refetchOnWindowFocus: false,
  });
}

export function useBrainListItems(
  repoRoot: string | null,
  collection: string | null,
  name: string | null,
  options?: { limit?: number; offset?: number; order?: "asc" | "desc" }
) {
  return useQuery<{
    items: BrainListItem[];
    totalCount: number;
    revision: number;
  }>({
    queryKey: ["brain", "list-items", repoRoot, collection, name, options],
    queryFn: () => {
      const params = new URLSearchParams({ repoRoot: repoRoot! });
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.offset) params.set("offset", String(options.offset));
      if (options?.order) params.set("order", options.order);
      return api(
        `/api/v1/brain/lists/${encodeURIComponent(collection!)}/${encodeURIComponent(name!)}?${params.toString()}`
      );
    },
    enabled: !!repoRoot && !!collection && !!name,
    refetchOnWindowFocus: false,
  });
}

export function useBrainEvents(
  repoRoot: string | null,
  filters?: {
    collection?: string;
    kind?: string;
    subject?: string;
    tags?: string[];
    since?: string;
    until?: string;
    limit?: number;
  }
) {
  return useQuery<BrainEvent[]>({
    queryKey: ["brain", "events", repoRoot, filters],
    queryFn: () => {
      const params = new URLSearchParams({ repoRoot: repoRoot! });
      if (filters?.collection) params.set("collection", filters.collection);
      if (filters?.kind) params.set("kind", filters.kind);
      if (filters?.subject) params.set("subject", filters.subject);
      if (filters?.tags?.length) params.set("tags", filters.tags.join(","));
      if (filters?.since) params.set("since", filters.since);
      if (filters?.until) params.set("until", filters.until);
      if (filters?.limit) params.set("limit", String(filters.limit));
      return api<BrainEvent[]>(`/api/v1/brain/events?${params.toString()}`);
    },
    enabled: !!repoRoot,
    refetchOnWindowFocus: false,
  });
}

/**
 * Unfiltered totals for the active scope — one collection, or the whole
 * project. Which query answers that is this module's business, not a
 * component's; both are already cached by the sidebar and the pane header, and
 * this is the seam a server-side scope-summary endpoint would land behind.
 * Returns undefined until the totals are known.
 */
export function useBrainScopeTotals(
  repoRoot: string | null,
  collection: string | null
): ScopeTotals | undefined {
  const { data: collections = [] } = useBrainCollections(repoRoot);
  const { data: projects = [] } = useBrainProjects();

  if (!repoRoot) return undefined;
  return collection
    ? collections.find((c) => c.collection === collection)
    : projects.find((p) => p.repoRoot === repoRoot);
}

export function useBrainActions() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["brain"] });

  const deleteObject = useMutation({
    mutationFn: ({
      repoRoot,
      collection,
      name,
    }: {
      repoRoot: string;
      collection: string;
      name: string;
    }) =>
      api<{ deleted: boolean }>(
        `/api/v1/brain/objects/${encodeURIComponent(collection)}/${encodeURIComponent(name)}?${new URLSearchParams({ repoRoot })}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });

  const deleteEvent = useMutation({
    mutationFn: ({ repoRoot, id }: { repoRoot: string; id: string }) =>
      api<{ deleted: boolean }>(
        `/api/v1/brain/events/${encodeURIComponent(id)}?${new URLSearchParams({ repoRoot })}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });

  const deleteList = useMutation({
    mutationFn: ({
      repoRoot,
      collection,
      name,
    }: {
      repoRoot: string;
      collection: string;
      name: string;
    }) =>
      api<{ deleted: boolean }>(
        `/api/v1/brain/lists/${encodeURIComponent(collection)}/${encodeURIComponent(name)}?${new URLSearchParams({ repoRoot })}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });

  const deleteCollection = useMutation({
    mutationFn: ({
      repoRoot,
      collection,
    }: {
      repoRoot: string;
      collection: string;
    }) =>
      api<{ objects: number; lists: number; events: number }>(
        `/api/v1/brain/collections/${encodeURIComponent(collection)}?${new URLSearchParams({ repoRoot })}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });

  const deleteEntriesOfType = useMutation({
    mutationFn: ({
      repoRoot,
      entryType,
      collection,
    }: {
      repoRoot: string;
      entryType: BrainEntryType;
      /** null clears the entry type across every collection in the project. */
      collection: string | null;
    }) => {
      const params = new URLSearchParams({ repoRoot });
      if (collection === null) params.set("allCollections", "true");
      else params.set("collection", collection);
      return api<{ deleted: number }>(
        `/api/v1/brain/${entryType}?${params.toString()}`,
        { method: "DELETE" }
      );
    },
    onSuccess: invalidate,
  });

  const deleteProject = useMutation({
    mutationFn: ({ repoRoot }: { repoRoot: string }) =>
      api<{ objects: number; lists: number; events: number }>(
        `/api/v1/brain/projects?${new URLSearchParams({ repoRoot })}`,
        { method: "DELETE" }
      ),
    onSuccess: invalidate,
  });

  return {
    deleteObject,
    deleteList,
    deleteEvent,
    deleteEntriesOfType,
    deleteCollection,
    deleteProject,
  };
}
