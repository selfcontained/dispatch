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

/** Lightbox identity: owner plus name, without updatedAt (see openLightbox). */
function fileId(file: { ownerAgentId?: string; name: string }): string {
  return `${file.ownerAgentId ?? ""}/${file.name}`;
}

/**
 * Referentially stable so react-query can skip re-running it; the returned
 * arrays are structurally shared with the underlying query data.
 */
function combineSubAgentFiles(
  results: Array<{ data?: MediaFile[] }>
): MediaFile[][] {
  return results.map((result) => result.data ?? EMPTY_FILES);
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
  const [lightboxFileName, setLightboxFileName] = useState<string | null>(null);
  // Snapshot of file names taken when the lightbox opens; feeds lightboxOrder
  // below. State, not a ref: lightboxOrder is a memo keyed on this value, and
  // a ref write doesn't invalidate a memo — the fresh snapshot would only
  // take effect on whatever unrelated render next changed lightboxItems,
  // leaving n/N and prev/next wrong for everything in between.
  const [lightboxOrderSnapshot, setLightboxOrderSnapshot] = useState<
    string[] | null
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
        files: (subAgentFiles[index] ?? EMPTY_FILES).map((file) => ({
          ...file,
          ownerAgentId: agent.id,
        })),
      })),
    [subAgents, subAgentFiles]
  );
  const allFiles = useMemo(
    () => [...mediaFiles, ...subAgentMedia.flatMap((group) => group.files)],
    [mediaFiles, subAgentMedia]
  );

  useEffect(() => {
    if (!selectedAgentId || !mediaPanelOpen) return;
    void refetchMedia();
  }, [mediaPanelOpen, refetchMedia, selectedAgentId]);

  // Reset on agent change.
  useEffect(() => {
    previousMediaKeysRef.current = new Set();
    setLightboxOrderSnapshot(null);
    setLightboxFileName(null);
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
  }, [markSeenInCache, allFiles, mediaPanelOpen, queryClient, selectedAgentId]);

  const unseenMediaCount = useMemo(() => {
    return allFiles.filter((file) => !file.seen).length;
  }, [allFiles]);

  // The open lightbox item is tracked by file name alone, unlike the
  // `name:updatedAt` media key used elsewhere in this hook (seen-tracking,
  // animation) — an agent rewriting the open file must not make this lookup
  // miss and unmount the lightbox, so identity here can't include updatedAt.
  const openLightbox = useCallback(
    (file: MediaFile) => {
      // Snapshot the navigation order only on the closed->open transition,
      // not when switching the already-open item. The list is sorted by
      // updated_at DESC, so leaving this live would reshuffle prev/next
      // and n/N under the reader every time any file in the list updates.
      // (Plain read of lightboxFileName, not a functional setState updater —
      // updaters must stay pure, and this needs to read mediaFiles too.)
      if (lightboxFileName === null) {
        setLightboxOrderSnapshot(allFiles.map(fileId));
      }
      setLightboxFileName(fileId(file));
    },
    [lightboxFileName, allFiles]
  );

  const lightboxItems = useMemo(
    () =>
      allFiles.map((file) => ({
        // Cache-buster stays here so a refreshed file's content actually loads.
        src: `${file.url}?t=${encodeURIComponent(file.updatedAt)}`,
        caption: file.description || "",
        file,
      })),
    [allFiles]
  );

  // Navigation order for one open-lightbox session: the snapshot taken at
  // open time, minus files that have since disappeared, plus files that
  // have since arrived (appended at the end, not reshuffled in). Content
  // itself (lightboxItem below) is always looked up live by name, so a
  // same-file refresh still shows fresh content — only traversal order and
  // n/N are frozen.
  const lightboxOrder = useMemo(() => {
    const liveIds = new Set(lightboxItems.map((item) => fileId(item.file)));
    const frozen = (lightboxOrderSnapshot ?? []).filter((id) =>
      liveIds.has(id)
    );
    const frozenSet = new Set(frozen);
    for (const item of lightboxItems) {
      const id = fileId(item.file);
      if (!frozenSet.has(id)) frozen.push(id);
    }
    return frozen;
  }, [lightboxItems, lightboxOrderSnapshot]);

  const lightboxIndex = lightboxFileName
    ? lightboxOrder.indexOf(lightboxFileName)
    : -1;

  const lightboxItem = useMemo(
    () =>
      lightboxFileName
        ? (lightboxItems.find(
            (item) => fileId(item.file) === lightboxFileName
          ) ?? null)
        : null,
    [lightboxItems, lightboxFileName]
  );

  const setLightboxIndex = useCallback(
    (nextIndex: number | null) => {
      if (nextIndex === null) {
        setLightboxOrderSnapshot(null);
        setLightboxFileName(null);
        return;
      }

      const name = lightboxOrder[nextIndex];
      if (name === undefined) return;

      setLightboxFileName(name);
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
      mediaFiles,
      subAgentMedia,
      animatingMediaKeys,
      unseenMediaCount,
      lightboxIndex,
      // Total for n/N and bounds-checking, matching the frozen order
      // lightboxIndex is computed against — not mediaFiles.length, which
      // can differ if a file arrived or disappeared mid-session.
      lightboxTotalItems: lightboxOrder.length,
      lightboxItem,
      setLightboxIndex,
      openLightbox,
      mediaViewportRef: mediaViewportRef as RefObject<HTMLDivElement>,
      refreshMedia,
    }),
    [
      mediaFiles,
      subAgentMedia,
      animatingMediaKeys,
      unseenMediaCount,
      lightboxIndex,
      lightboxOrder,
      lightboxItem,
      setLightboxIndex,
      openLightbox,
      refreshMedia,
    ]
  );
}
