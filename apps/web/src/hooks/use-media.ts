import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type MediaFile,
  type SubAgentMedia,
  type SubAgentRef,
} from "@/components/app/types";
import { api } from "@/lib/api";

const EMPTY_FILES: MediaFile[] = [];
const EMPTY_SUB_AGENTS: SubAgentRef[] = [];

export const MEDIA_ITEM_QUERY_PREFIX = ["media", "item"] as const;

export function mediaItemQueryKey(mediaId: number) {
  return [...MEDIA_ITEM_QUERY_PREFIX, mediaId] as const;
}

async function fetchMedia(agentId: string): Promise<MediaFile[]> {
  const payload = await api<{ files: MediaFile[] }>(
    `/api/v1/agents/${agentId}/media`
  );
  return payload.files ?? [];
}

/**
 * Identity of a file across every agent listed in one panel. The server key
 * (`name:updatedAt`) is only unique per agent, and a parent's panel lists its
 * children's files too, so the owner is part of the key.
 */
function ownedMediaKey(file: MediaFile): string {
  return `${file.ownerAgentId ?? ""}/${file.name}:${file.updatedAt}`;
}

/**
 * Referentially stable so react-query can skip re-running it; the returned
 * arrays are structurally shared with the underlying query data.
 */
function combineSubAgentFiles(
  results: Array<{
    data?: MediaFile[];
    status: "pending" | "error" | "success";
  }>
): Array<{ files: MediaFile[]; status: "pending" | "error" | "success" }> {
  return results.map((result) => ({
    files: result.data ?? EMPTY_FILES,
    status: result.status,
  }));
}

export function useMedia(
  selectedAgentId: string | null,
  mediaPanelOpen: boolean,
  /**
   * The selected agent's direct children. Their media is fetched under the
   * same `["media", id]` keys the SSE `media.changed` handler invalidates,
   * so a child sharing a screenshot updates the parent's panel live.
   */
  subAgents: SubAgentRef[] = EMPTY_SUB_AGENTS
) {
  const queryClient = useQueryClient();

  const [animatingMediaKeys, setAnimatingMediaKeys] = useState<Set<string>>(
    new Set()
  );
  const [lightboxMediaId, setLightboxMediaIdState] = useState<number | null>(
    null
  );
  // Snapshot of media IDs taken when the lightbox opens; feeds lightboxOrder
  // below. State, not a ref: lightboxOrder is a memo keyed on this value, and
  // a ref write doesn't invalidate a memo — the fresh snapshot would only
  // take effect on some unrelated render, leaving n/N and prev/next wrong in
  // the meantime.
  const [lightboxOrderSnapshot, setLightboxOrderSnapshot] = useState<
    number[] | null
  >(null);
  const mediaViewportRef = useRef<HTMLDivElement>(null);
  const previousMediaKeysRef = useRef<Set<string>>(new Set());
  const clearMediaAnimTimerRef = useRef<number | null>(null);

  const { data: ownFiles = EMPTY_FILES, refetch: refetchMedia } = useQuery<
    MediaFile[]
  >({
    queryKey: ["media", selectedAgentId],
    queryFn: () => fetchMedia(selectedAgentId as string),
    enabled: !!selectedAgentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const subAgentFiles = useQueries({
    queries: subAgents.map((agent) => ({
      queryKey: ["media", agent.id],
      queryFn: () => fetchMedia(agent.id),
      enabled: !!selectedAgentId,
      staleTime: 0,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    })),
    combine: combineSubAgentFiles,
  });

  // The API does not say whose file a row is — it is implied by the URL —
  // so stamp the owner here, where several agents' lists meet.
  const mediaFiles = useMemo(
    () =>
      selectedAgentId
        ? ownFiles.map((file) => ({ ...file, ownerAgentId: selectedAgentId }))
        : ownFiles,
    [ownFiles, selectedAgentId]
  );
  const subAgentMedia: SubAgentMedia[] = useMemo(
    () =>
      subAgents.map((agent, index) => ({
        agent,
        files: (subAgentFiles[index]?.files ?? EMPTY_FILES).map((file) => ({
          ...file,
          ownerAgentId: agent.id,
        })),
        status: subAgentFiles[index]?.status ?? "pending",
      })),
    [subAgents, subAgentFiles]
  );
  const allFiles = useMemo(
    () => [...mediaFiles, ...subAgentMedia.flatMap((group) => group.files)],
    [mediaFiles, subAgentMedia]
  );

  // The owner-scoped lists already have complete media rows. Seed the
  // owner-independent item cache so opening from the Media panel paints
  // immediately; MediaLightbox still revalidates the item in the background.
  useEffect(() => {
    for (const file of allFiles) {
      queryClient.setQueryData<MediaFile>(mediaItemQueryKey(file.id), file);
    }
  }, [allFiles, queryClient]);

  // Whose files the Media tab shows: null is the selected agent, otherwise
  // one sub agent. Lives here rather than in the panel because the lightbox
  // order and the seen observer both follow what is on screen. Falls back
  // to the agent's own files if the chosen sub agent leaves the list.
  const [mediaOwnerId, setMediaOwnerId] = useState<string | null>(null);
  useEffect(() => {
    setMediaOwnerId(null);
  }, [selectedAgentId]);
  const viewedSubAgent =
    mediaOwnerId === null
      ? null
      : (subAgentMedia.find((group) => group.agent.id === mediaOwnerId) ??
        null);
  const visibleMediaFiles = viewedSubAgent ? viewedSubAgent.files : mediaFiles;

  useEffect(() => {
    if (!selectedAgentId || !mediaPanelOpen) return;
    void refetchMedia();
  }, [mediaPanelOpen, refetchMedia, selectedAgentId]);

  // Reset on agent change.
  useEffect(() => {
    previousMediaKeysRef.current = new Set();
    setLightboxOrderSnapshot(null);
    setLightboxMediaIdState(null);
  }, [selectedAgentId]);

  // Clear media when no agent selected.
  useEffect(() => {
    if (!selectedAgentId) {
      queryClient.setQueryData(["media", null], []);
    }
  }, [queryClient, selectedAgentId]);

  // Animation for new media items.
  useEffect(() => {
    const nextKeys = allFiles.map(ownedMediaKey);
    const prevKeys = previousMediaKeysRef.current;

    if (prevKeys.size > 0) {
      const incoming = nextKeys.filter((key) => !prevKeys.has(key));
      if (incoming.length > 0) {
        setAnimatingMediaKeys(new Set(incoming));

        if (clearMediaAnimTimerRef.current) {
          window.clearTimeout(clearMediaAnimTimerRef.current);
        }
        clearMediaAnimTimerRef.current = window.setTimeout(() => {
          setAnimatingMediaKeys(new Set());
          clearMediaAnimTimerRef.current = null;
        }, 2200);
      }
    }

    previousMediaKeysRef.current = new Set(nextKeys);

    return () => {
      if (clearMediaAnimTimerRef.current) {
        window.clearTimeout(clearMediaAnimTimerRef.current);
        clearMediaAnimTimerRef.current = null;
      }
    };
  }, [allFiles]);

  // Optimistically mark files as seen in the query cache.
  const markSeenInCache = useCallback(
    (agentId: string, keys: Set<string>) => {
      queryClient.setQueryData<MediaFile[]>(["media", agentId], (old) => {
        if (!old) return old;
        return old.map((file) => {
          const key = `${file.name}:${file.updatedAt}`;
          return keys.has(key) && !file.seen ? { ...file, seen: true } : file;
        });
      });
    },
    [queryClient]
  );

  // IntersectionObserver for marking media as seen. "Seen" belongs to the
  // file's owner, not to whichever agent's panel it was scrolled past in:
  // a child's screenshot seen under the parent is marked on the child, so
  // the child's own panel and the badges agree.
  useEffect(() => {
    if (!mediaPanelOpen) return;

    const root = mediaViewportRef.current;
    const selected = selectedAgentId;
    if (!root || !selected) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const newlySeenByOwner = new Map<string, string[]>();

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const { mediaKey, mediaOwner } = (entry.target as HTMLElement)
            .dataset;
          const owner = mediaOwner || selected;
          if (!mediaKey) continue;
          // Check if already seen in current cache data
          const cached = queryClient.getQueryData<MediaFile[]>([
            "media",
            owner,
          ]);
          const file = cached?.find(
            (f) => `${f.name}:${f.updatedAt}` === mediaKey
          );
          if (file && !file.seen) {
            const keys = newlySeenByOwner.get(owner) ?? [];
            keys.push(mediaKey);
            newlySeenByOwner.set(owner, keys);
          }
        }

        for (const [owner, newlySeen] of newlySeenByOwner) {
          // Optimistic cache update
          markSeenInCache(owner, new Set(newlySeen));
          // Persist to server
          void api(`/api/v1/agents/${owner}/media/seen`, {
            method: "POST",
            body: JSON.stringify({ keys: newlySeen }),
          }).catch(() => {});
        }
      },
      { root, threshold: 0.65 }
    );

    const nodes = root.querySelectorAll<HTMLElement>("[data-media-key]");
    nodes.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
    };
    // Keyed on the files on screen, not every family file: switching owner
    // swaps the rendered cards without changing the full list, and the
    // observer has to attach to the new nodes.
  }, [
    markSeenInCache,
    visibleMediaFiles,
    mediaPanelOpen,
    queryClient,
    selectedAgentId,
  ]);

  const unseenMediaCount = useMemo(() => {
    return allFiles.filter((file) => !file.seen).length;
  }, [allFiles]);

  const ownerFileIds = useCallback(
    (mediaId: number): number[] => {
      const openedFile = allFiles.find((file) => file.id === mediaId);
      if (!openedFile?.ownerAgentId) return [];
      return allFiles
        .filter((file) => file.ownerAgentId === openedFile.ownerAgentId)
        .map((file) => file.id);
    },
    [allFiles]
  );

  // The lightbox boundary is the stable media row ID. Chat already has it, and
  // MediaLightbox resolves metadata by ID, so opening does not depend on the
  // current owner's media query having loaded.
  const openLightbox = useCallback(
    (mediaId: number) => {
      // Snapshot the navigation order only on the closed->open transition,
      // not when navigating. The list is sorted by updated_at DESC, so leaving
      // this live would reshuffle prev/next and n/N under the reader every time
      // any file in the list updates.
      if (lightboxMediaId === null) {
        const ownerIds = ownerFileIds(mediaId);
        setLightboxOrderSnapshot(ownerIds.length > 0 ? ownerIds : null);
      }
      setLightboxMediaIdState(mediaId);
    },
    [lightboxMediaId, ownerFileIds]
  );

  // Chat can open an ID before its owner-scoped list has loaded. Take the
  // frozen order exactly once, when that list first reveals the item's owner.
  useEffect(() => {
    if (lightboxMediaId === null || lightboxOrderSnapshot !== null) return;
    const ownerIds = ownerFileIds(lightboxMediaId);
    if (ownerIds.length > 0) setLightboxOrderSnapshot(ownerIds);
  }, [lightboxMediaId, lightboxOrderSnapshot, ownerFileIds]);

  // Navigation order for one open-lightbox session: the snapshot taken at
  // open time, minus files that have since disappeared, plus files that
  // have since arrived (appended at the end, not reshuffled in). Content
  // itself is loaded by MediaLightbox from its ID, so only traversal order is
  // frozen here.
  const lightboxOrder = useMemo(() => {
    if (lightboxMediaId === null) return [];
    if (lightboxOrderSnapshot === null) return [lightboxMediaId];

    const ownerIds = ownerFileIds(lightboxMediaId);
    if (ownerIds.length === 0) return [lightboxMediaId];

    const lightboxLiveIds = ownerIds;
    const liveIds = new Set(lightboxLiveIds);
    const frozen = lightboxOrderSnapshot.filter((id) => liveIds.has(id));
    const frozenSet = new Set(frozen);
    for (const id of lightboxLiveIds) {
      if (!frozenSet.has(id)) frozen.push(id);
    }
    return frozen;
  }, [lightboxMediaId, lightboxOrderSnapshot, ownerFileIds]);

  const setLightboxMediaId = useCallback(
    (nextMediaId: number | null) => {
      if (nextMediaId === null) {
        setLightboxOrderSnapshot(null);
        setLightboxMediaIdState(null);
        return;
      }
      if (!lightboxOrder.includes(nextMediaId)) return;
      setLightboxMediaIdState(nextMediaId);
    },
    [lightboxOrder]
  );

  const refreshMedia = useCallback(
    (agentId?: string | null) => {
      const id = agentId ?? selectedAgentId;
      if (id) {
        void queryClient.invalidateQueries({ queryKey: ["media", id] });
      }
    },
    [queryClient, selectedAgentId]
  );

  return useMemo(
    () => ({
      /** The selected agent's own files. */
      mediaFiles,
      /** The files the Media tab is showing: own, or the chosen sub agent's. */
      visibleMediaFiles,
      subAgentMedia,
      mediaOwnerId: viewedSubAgent?.agent.id ?? null,
      setMediaOwnerId,
      animatingMediaKeys,
      unseenMediaCount,
      lightboxMediaId,
      lightboxMediaIds: lightboxOrder,
      setLightboxMediaId,
      openLightbox,
      mediaViewportRef: mediaViewportRef as RefObject<HTMLDivElement>,
      refreshMedia,
    }),
    [
      mediaFiles,
      visibleMediaFiles,
      subAgentMedia,
      viewedSubAgent,
      animatingMediaKeys,
      unseenMediaCount,
      lightboxMediaId,
      lightboxOrder,
      setLightboxMediaId,
      openLightbox,
      refreshMedia,
    ]
  );
}
