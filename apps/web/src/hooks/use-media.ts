import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MediaFile } from "@/components/app/types";
import { api } from "@/lib/api";

export function useMedia(
  selectedAgentId: string | null,
  mediaPanelOpen: boolean
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

  const { data: mediaFiles = [], refetch: refetchMedia } = useQuery<
    MediaFile[]
  >({
    queryKey: ["media", selectedAgentId],
    queryFn: async () => {
      const payload = await api<{ files: MediaFile[] }>(
        `/api/v1/agents/${selectedAgentId}/media`
      );
      return payload.files ?? [];
    },
    enabled: !!selectedAgentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

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
    const nextKeys = mediaFiles.map((file) => `${file.name}:${file.updatedAt}`);
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
  }, [mediaFiles]);

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

  // IntersectionObserver for marking media as seen.
  useEffect(() => {
    if (!mediaPanelOpen) return;

    const root = mediaViewportRef.current;
    const selected = selectedAgentId;
    if (!root || !selected) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const newlySeen: string[] = [];

        for (const entry of entries) {
          if (entry.isIntersecting) {
            const mediaKey = (entry.target as HTMLElement).dataset.mediaKey;
            if (mediaKey) {
              // Check if already seen in current cache data
              const cached = queryClient.getQueryData<MediaFile[]>([
                "media",
                selected,
              ]);
              const file = cached?.find(
                (f) => `${f.name}:${f.updatedAt}` === mediaKey
              );
              if (file && !file.seen) {
                newlySeen.push(mediaKey);
              }
            }
          }
        }

        if (newlySeen.length > 0) {
          // Optimistic cache update
          markSeenInCache(selected, new Set(newlySeen));
          // Persist to server
          void api(`/api/v1/agents/${selected}/media/seen`, {
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
  }, [
    markSeenInCache,
    mediaFiles,
    mediaPanelOpen,
    queryClient,
    selectedAgentId,
  ]);

  const unseenMediaCount = useMemo(() => {
    return mediaFiles.filter((file) => !file.seen).length;
  }, [mediaFiles]);

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
        setLightboxOrderSnapshot(mediaFiles.map((f) => f.name));
      }
      setLightboxFileName(file.name);
    },
    [lightboxFileName, mediaFiles]
  );

  const lightboxItems = useMemo(
    () =>
      mediaFiles.map((file) => ({
        // Cache-buster stays here so a refreshed file's content actually loads.
        src: `${file.url}?t=${encodeURIComponent(file.updatedAt)}`,
        caption: file.description || "",
        file,
      })),
    [mediaFiles]
  );

  // Navigation order for one open-lightbox session: the snapshot taken at
  // open time, minus files that have since disappeared, plus files that
  // have since arrived (appended at the end, not reshuffled in). Content
  // itself (lightboxItem below) is always looked up live by name, so a
  // same-file refresh still shows fresh content — only traversal order and
  // n/N are frozen.
  const lightboxOrder = useMemo(() => {
    const liveNames = new Set(lightboxItems.map((item) => item.file.name));
    const frozen = (lightboxOrderSnapshot ?? []).filter((name) =>
      liveNames.has(name)
    );
    const frozenSet = new Set(frozen);
    for (const item of lightboxItems) {
      if (!frozenSet.has(item.file.name)) frozen.push(item.file.name);
    }
    return frozen;
  }, [lightboxItems, lightboxOrderSnapshot]);

  const lightboxIndex = lightboxFileName
    ? lightboxOrder.indexOf(lightboxFileName)
    : -1;

  const lightboxItem = useMemo(
    () =>
      lightboxFileName
        ? (lightboxItems.find((item) => item.file.name === lightboxFileName) ??
          null)
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
