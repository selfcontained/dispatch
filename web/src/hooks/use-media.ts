import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MediaFile } from "@/components/app/types";
import { api } from "@/lib/api";

export function useMedia(selectedAgentId: string | null, mediaPanelOpen: boolean) {
  const queryClient = useQueryClient();

  const [seenMediaKeys, setSeenMediaKeys] = useState<Set<string>>(new Set());
  const [animatingMediaKeys, setAnimatingMediaKeys] = useState<Set<string>>(new Set());
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState("");
  const mediaViewportRef = useRef<HTMLDivElement>(null);
  const previousMediaKeysRef = useRef<Set<string>>(new Set());
  const clearMediaAnimTimerRef = useRef<number | null>(null);

  const { data: mediaFiles = [] } = useQuery<MediaFile[]>({
    queryKey: ["media", selectedAgentId],
    queryFn: async () => {
      const payload = await api<{ files: MediaFile[] }>(`/api/v1/agents/${selectedAgentId}/media`);
      return payload.files ?? [];
    },
    enabled: !!selectedAgentId,
  });

  // Sync seenMediaKeys from fetched data.
  useEffect(() => {
    if (mediaFiles.length > 0) {
      setSeenMediaKeys(
        new Set(
          mediaFiles
            .filter((file) => file.seen === true)
            .map((file) => `${file.name}:${file.updatedAt}`)
        )
      );
    }
  }, [mediaFiles]);

  // Reset seen keys when selected agent changes.
  useEffect(() => {
    setSeenMediaKeys(new Set());
    previousMediaKeysRef.current = new Set();
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

  // IntersectionObserver for marking media as seen.
  const markMediaSeen = useCallback(
    async (agentId: string, keys: string[]) => {
      if (keys.length === 0) return;
      try {
        await api<{ ok: boolean; updated: number }>(`/api/v1/agents/${agentId}/media/seen`, {
          method: "POST",
          body: JSON.stringify({ keys }),
        });
      } catch {}
    },
    []
  );

  useEffect(() => {
    if (!mediaPanelOpen) return;

    const root = mediaViewportRef.current;
    const selected = selectedAgentId;
    if (!root || !selected) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const newlySeen: string[] = [];
        setSeenMediaKeys((current) => {
          let changed = false;
          const next = new Set(current);

          for (const entry of entries) {
            if (entry.isIntersecting) {
              const mediaKey = (entry.target as HTMLElement).dataset.mediaKey;
              if (mediaKey && !next.has(mediaKey)) {
                next.add(mediaKey);
                newlySeen.push(mediaKey);
                changed = true;
              }
            }
          }

          return changed ? next : current;
        });

        if (newlySeen.length > 0) {
          void markMediaSeen(selected, newlySeen);
        }
      },
      { root, threshold: 0.65 }
    );

    const nodes = root.querySelectorAll<HTMLElement>("[data-media-key]");
    nodes.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
    };
  }, [markMediaSeen, mediaFiles, mediaPanelOpen, selectedAgentId]);

  const unseenMediaCount = useMemo(() => {
    return mediaFiles.filter((file) => !seenMediaKeys.has(`${file.name}:${file.updatedAt}`)).length;
  }, [mediaFiles, seenMediaKeys]);

  const openLightbox = useCallback((src: string, caption: string) => {
    setLightboxSrc(src);
    setLightboxCaption(caption);
  }, []);

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
    seenMediaKeys,
    setSeenMediaKeys,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxSrc,
    lightboxCaption,
    setLightboxSrc,
    openLightbox,
    mediaViewportRef: mediaViewportRef as RefObject<HTMLDivElement>,
    refreshMedia,
  }), [
    mediaFiles,
    seenMediaKeys,
    animatingMediaKeys,
    unseenMediaCount,
    lightboxSrc,
    lightboxCaption,
    openLightbox,
    refreshMedia,
  ]);
}
