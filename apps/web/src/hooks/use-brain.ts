import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

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

export type BrainList = {
  collection: string;
  name: string;
  revision: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  createdByAgentId: string;
  updatedByAgentId: string;
};

export type BrainListItem = {
  index: number;
  value: unknown;
  createdAt: string;
  updatedAt: string;
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
