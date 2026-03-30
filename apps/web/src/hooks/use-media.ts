import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MediaFile } from "@/components/app/types";
import { api } from "@/lib/api";

export function useMedia(selectedAgentId: string | null, mediaPanelOpen: boolean) {
  const queryClient = useQueryClient();

  const [animatingMediaKeys, setAnimatingMediaKeys] = useState<Set<string>>(new Set());
  const [lightboxMediaKey, setLightboxMediaKey] = useState<string | null>(null);
  const mediaViewportRef = useRef<HTMLDivElement>(null);
  const previousMediaKeysRef = useRef<Set<string>>(new Set());
  const clearMediaAnimTimerRef = useRef<number | null>(null);

  const { data: mediaFiles = [], refetch: refetchMedia } = useQuery<MediaFile[]>({
    queryKey: ["media", selectedAgentId],
    queryFn: async () => {
      const payload = await api<{ files: MediaFile[] }>(`/api/v1/agents/${selectedAgentId}/media`);
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
    setLightboxMediaKey(null);
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
              const cached = queryClient.getQueryData<MediaFile[]>(["media", selected]);
              const file = cached?.find((f) => `${f.name}:${f.updatedAt}` === mediaKey);
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
  }, [markSeenInCache, mediaFiles, mediaPanelOpen, queryClient, selectedAgentId]);

  const unseenMediaCount = useMemo(() => {
    return mediaFiles.filter((file) => !file.seen).length;
  }, [mediaFiles]);

  const openLightbox = useCallback((file: MediaFile) => {
    setLightboxMediaKey(`${file.name}:${file.updatedAt}`);
  }, []);

  const lightboxItems = useMemo(
    () => mediaFiles.map((file) => ({
      key: `${file.name}:${file.updatedAt}`,
      src: `${file.url}?t=${encodeURIComponent(file.updatedAt)}`,
      caption: file.description || "",
      file,
    })),
    [mediaFiles]
  );

  const lightboxIndex = useMemo(() => {
    if (!lightboxMediaKey) return -1;
    return lightboxItems.findIndex((item) => item.key === lightboxMediaKey);
  }, [lightboxItems, lightboxMediaKey]);

  const lightboxItem = lightboxIndex >= 0 ? lightboxItems[lightboxIndex] : null;

  const setLightboxIndex = useCallback(
    (nextIndex: number | null) => {
      if (nextIndex === null) {
        setLightboxMediaKey(null);
        return;
      }

      if (nextIndex < 0 || nextIndex >= lightboxItems.length) {
        return;
      }

      setLightboxMediaKey(lightboxItems[nextIndex].key);
    },
    [lightboxItems]
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

  return useMemo(() => ({
    mediaFiles,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxIndex,
    lightboxItem,
    setLightboxIndex,
    openLightbox,
    mediaViewportRef: mediaViewportRef as RefObject<HTMLDivElement>,
    refreshMedia,
    markSeenInCache,
  }), [
    mediaFiles,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxIndex,
    lightboxItem,
    setLightboxIndex,
    openLightbox,
    refreshMedia,
    markSeenInCache,
  ]);
}
