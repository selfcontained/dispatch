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
  type FileItem,
  type SubAgentFiles,
  type SubAgentRef,
} from "@/components/app/types";
import { api } from "@/lib/api";

const EMPTY_FILES: FileItem[] = [];
const EMPTY_SUB_AGENTS: SubAgentRef[] = [];

export const FILE_ITEM_QUERY_PREFIX = ["files", "item"] as const;

export function fileItemQueryKey(fileId: number) {
  return [...FILE_ITEM_QUERY_PREFIX, fileId] as const;
}

async function fetchFiles(agentId: string): Promise<FileItem[]> {
  const payload = await api<{ files: FileItem[] }>(
    `/api/v1/agents/${agentId}/files`
  );
  return payload.files ?? [];
}

/**
 * Identity of a file across every agent listed in one panel. The server key
 * (`name:updatedAt`) is only unique per agent, and a parent's panel lists its
 * children's files too, so the owner is part of the key.
 */
function ownedFileKey(file: FileItem): string {
  return `${file.ownerAgentId ?? ""}/${file.name}:${file.updatedAt}`;
}

/**
 * Referentially stable so react-query can skip re-running it; the returned
 * arrays are structurally shared with the underlying query data.
 */
function combineSubAgentFiles(
  results: Array<{
    data?: FileItem[];
    status: "pending" | "error" | "success";
  }>
): Array<{ files: FileItem[]; status: "pending" | "error" | "success" }> {
  return results.map((result) => ({
    files: result.data ?? EMPTY_FILES,
    status: result.status,
  }));
}

export function useFiles(
  selectedAgentId: string | null,
  drawerPanelOpen: boolean,
  /**
   * The selected agent's direct children. Their files are fetched under the
   * same `["files", id]` keys the SSE `files.changed` handler invalidates,
   * so a child sharing a screenshot updates the parent's panel live.
   */
  subAgents: SubAgentRef[] = EMPTY_SUB_AGENTS
) {
  const queryClient = useQueryClient();

  const [animatingFileKeys, setAnimatingFileKeys] = useState<Set<string>>(
    new Set()
  );
  const [lightboxFileId, setLightboxFileIdState] = useState<number | null>(
    null
  );
  // Snapshot of file IDs taken when the lightbox opens; feeds lightboxOrder
  // below. State, not a ref: lightboxOrder is a memo keyed on this value, and
  // a ref write doesn't invalidate a memo — the fresh snapshot would only
  // take effect on some unrelated render, leaving n/N and prev/next wrong in
  // the meantime.
  const [lightboxOrderSnapshot, setLightboxOrderSnapshot] = useState<
    number[] | null
  >(null);
  // A caller-given order for this lightbox session (one post's images), used
  // as-is in place of the owner's files.
  const [lightboxScope, setLightboxScope] = useState<number[] | null>(null);
  const drawerViewportRef = useRef<HTMLDivElement>(null);
  const previousFileKeysRef = useRef<Set<string>>(new Set());
  const clearFileAnimTimerRef = useRef<number | null>(null);

  const { data: ownFiles = EMPTY_FILES, refetch: refetchFiles } = useQuery<
    FileItem[]
  >({
    queryKey: ["files", selectedAgentId],
    queryFn: () => fetchFiles(selectedAgentId as string),
    enabled: !!selectedAgentId,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const subAgentQueries = useQueries({
    queries: subAgents.map((agent) => ({
      queryKey: ["files", agent.id],
      queryFn: () => fetchFiles(agent.id),
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
  const files = useMemo(
    () =>
      selectedAgentId
        ? ownFiles.map((file) => ({ ...file, ownerAgentId: selectedAgentId }))
        : ownFiles,
    [ownFiles, selectedAgentId]
  );
  const subAgentFiles: SubAgentFiles[] = useMemo(
    () =>
      subAgents.map((agent, index) => ({
        agent,
        files: (subAgentQueries[index]?.files ?? EMPTY_FILES).map((file) => ({
          ...file,
          ownerAgentId: agent.id,
        })),
        status: subAgentQueries[index]?.status ?? "pending",
      })),
    [subAgents, subAgentQueries]
  );
  const allFiles = useMemo(
    () => [...files, ...subAgentFiles.flatMap((group) => group.files)],
    [files, subAgentFiles]
  );

  // The owner-scoped lists already have complete file rows. Seed the
  // owner-independent item cache so opening from the Files panel paints
  // immediately; FileLightbox still revalidates the item in the background.
  useEffect(() => {
    for (const file of allFiles) {
      queryClient.setQueryData<FileItem>(fileItemQueryKey(file.id), file);
    }
  }, [allFiles, queryClient]);

  // Whose files the Files tab shows: null is the selected agent, otherwise
  // one sub agent. Lives here rather than in the panel because the lightbox
  // order and the seen observer both follow what is on screen. Falls back
  // to the agent's own files if the chosen sub agent leaves the list.
  const [filesOwnerId, setFilesOwnerId] = useState<string | null>(null);
  useEffect(() => {
    setFilesOwnerId(null);
  }, [selectedAgentId]);
  const viewedSubAgent =
    filesOwnerId === null
      ? null
      : (subAgentFiles.find((group) => group.agent.id === filesOwnerId) ??
        null);
  const visibleFiles = viewedSubAgent ? viewedSubAgent.files : files;

  useEffect(() => {
    if (!selectedAgentId || !drawerPanelOpen) return;
    void refetchFiles();
  }, [drawerPanelOpen, refetchFiles, selectedAgentId]);

  // Reset on agent change.
  useEffect(() => {
    previousFileKeysRef.current = new Set();
    setLightboxOrderSnapshot(null);
    setLightboxScope(null);
    setLightboxFileIdState(null);
  }, [selectedAgentId]);

  // Clear files when no agent selected.
  useEffect(() => {
    if (!selectedAgentId) {
      queryClient.setQueryData(["files", null], []);
    }
  }, [queryClient, selectedAgentId]);

  // Animation for new file items.
  useEffect(() => {
    const nextKeys = allFiles.map(ownedFileKey);
    const prevKeys = previousFileKeysRef.current;

    if (prevKeys.size > 0) {
      const incoming = nextKeys.filter((key) => !prevKeys.has(key));
      if (incoming.length > 0) {
        setAnimatingFileKeys(new Set(incoming));

        if (clearFileAnimTimerRef.current) {
          window.clearTimeout(clearFileAnimTimerRef.current);
        }
        clearFileAnimTimerRef.current = window.setTimeout(() => {
          setAnimatingFileKeys(new Set());
          clearFileAnimTimerRef.current = null;
        }, 2200);
      }
    }

    previousFileKeysRef.current = new Set(nextKeys);

    return () => {
      if (clearFileAnimTimerRef.current) {
        window.clearTimeout(clearFileAnimTimerRef.current);
        clearFileAnimTimerRef.current = null;
      }
    };
  }, [allFiles]);

  // Optimistically mark files as seen in the query cache.
  const markSeenInCache = useCallback(
    (agentId: string, keys: Set<string>) => {
      queryClient.setQueryData<FileItem[]>(["files", agentId], (old) => {
        if (!old) return old;
        return old.map((file) => {
          const key = `${file.name}:${file.updatedAt}`;
          return keys.has(key) && !file.seen ? { ...file, seen: true } : file;
        });
      });
    },
    [queryClient]
  );

  // IntersectionObserver for marking files as seen. "Seen" belongs to the
  // file's owner, not to whichever agent's panel it was scrolled past in:
  // a child's screenshot seen under the parent is marked on the child, so
  // the child's own panel and the badges agree.
  useEffect(() => {
    if (!drawerPanelOpen) return;

    const root = drawerViewportRef.current;
    const selected = selectedAgentId;
    if (!root || !selected) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const newlySeenByOwner = new Map<string, string[]>();

        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const { fileKey, filesOwner } = (entry.target as HTMLElement).dataset;
          const owner = filesOwner || selected;
          if (!fileKey) continue;
          // Check if already seen in current cache data
          const cached = queryClient.getQueryData<FileItem[]>(["files", owner]);
          const file = cached?.find(
            (f) => `${f.name}:${f.updatedAt}` === fileKey
          );
          if (file && !file.seen) {
            const keys = newlySeenByOwner.get(owner) ?? [];
            keys.push(fileKey);
            newlySeenByOwner.set(owner, keys);
          }
        }

        for (const [owner, newlySeen] of newlySeenByOwner) {
          // Optimistic cache update
          markSeenInCache(owner, new Set(newlySeen));
          // Persist to server
          void api(`/api/v1/agents/${owner}/files/seen`, {
            method: "POST",
            body: JSON.stringify({ keys: newlySeen }),
          }).catch(() => {});
        }
      },
      { root, threshold: 0.65 }
    );

    const nodes = root.querySelectorAll<HTMLElement>("[data-file-key]");
    nodes.forEach((node) => observer.observe(node));

    return () => {
      observer.disconnect();
    };
    // Keyed on the files on screen, not every family file: switching owner
    // swaps the rendered cards without changing the full list, and the
    // observer has to attach to the new nodes.
  }, [
    markSeenInCache,
    visibleFiles,
    drawerPanelOpen,
    queryClient,
    selectedAgentId,
  ]);

  const unseenFileCount = useMemo(() => {
    return allFiles.filter((file) => !file.seen).length;
  }, [allFiles]);

  const ownerFileIds = useCallback(
    (fileId: number): number[] => {
      const openedFile = allFiles.find((file) => file.id === fileId);
      if (!openedFile?.ownerAgentId) return [];
      return allFiles
        .filter((file) => file.ownerAgentId === openedFile.ownerAgentId)
        .map((file) => file.id);
    },
    [allFiles]
  );

  // The lightbox boundary is the stable file row ID. Chat already has it, and
  // FileLightbox resolves metadata by ID, so opening does not depend on the
  // current owner's files query having loaded.
  const openLightbox = useCallback(
    (fileId: number, order?: number[]) => {
      setLightboxScope(order?.includes(fileId) ? order : null);
      // Snapshot the navigation order only on the closed->open transition,
      // not when navigating. The list is sorted by updated_at DESC, so leaving
      // this live would reshuffle prev/next and n/N under the reader every time
      // any file in the list updates.
      if (lightboxFileId === null) {
        const ownerIds = ownerFileIds(fileId);
        setLightboxOrderSnapshot(ownerIds.length > 0 ? ownerIds : null);
      }
      setLightboxFileIdState(fileId);
    },
    [lightboxFileId, ownerFileIds]
  );

  // Chat can open an ID before its owner-scoped list has loaded. Take the
  // frozen order exactly once, when that list first reveals the item's owner.
  useEffect(() => {
    if (lightboxFileId === null || lightboxOrderSnapshot !== null) return;
    const ownerIds = ownerFileIds(lightboxFileId);
    if (ownerIds.length > 0) setLightboxOrderSnapshot(ownerIds);
  }, [lightboxFileId, lightboxOrderSnapshot, ownerFileIds]);

  // Navigation order for one open-lightbox session: the snapshot taken at
  // open time, minus files that have since disappeared, plus files that
  // have since arrived (appended at the end, not reshuffled in). Content
  // itself is loaded by FileLightbox from its ID, so only traversal order is
  // frozen here.
  const lightboxOrder = useMemo(() => {
    if (lightboxFileId === null) return [];
    if (lightboxScope) return lightboxScope;
    if (lightboxOrderSnapshot === null) return [lightboxFileId];

    const ownerIds = ownerFileIds(lightboxFileId);
    if (ownerIds.length === 0) return [lightboxFileId];

    const lightboxLiveIds = ownerIds;
    const liveIds = new Set(lightboxLiveIds);
    const frozen = lightboxOrderSnapshot.filter((id) => liveIds.has(id));
    const frozenSet = new Set(frozen);
    for (const id of lightboxLiveIds) {
      if (!frozenSet.has(id)) frozen.push(id);
    }
    return frozen;
  }, [lightboxFileId, lightboxOrderSnapshot, lightboxScope, ownerFileIds]);

  const setLightboxFileId = useCallback(
    (nextFileId: number | null) => {
      if (nextFileId === null) {
        setLightboxOrderSnapshot(null);
        setLightboxScope(null);
        setLightboxFileIdState(null);
        return;
      }
      if (!lightboxOrder.includes(nextFileId)) return;
      setLightboxFileIdState(nextFileId);
    },
    [lightboxOrder]
  );

  const refreshFiles = useCallback(
    (agentId?: string | null) => {
      const id = agentId ?? selectedAgentId;
      if (id) {
        void queryClient.invalidateQueries({ queryKey: ["files", id] });
      }
    },
    [queryClient, selectedAgentId]
  );

  return useMemo(
    () => ({
      /** The selected agent's own files. */
      files,
      /** The files the Files tab is showing: own, or the chosen sub agent's. */
      visibleFiles,
      subAgentFiles,
      filesOwnerId: viewedSubAgent?.agent.id ?? null,
      setFilesOwnerId,
      animatingFileKeys,
      unseenFileCount,
      lightboxFileId,
      lightboxFileIds: lightboxOrder,
      setLightboxFileId,
      openLightbox,
      drawerViewportRef: drawerViewportRef as RefObject<HTMLDivElement>,
      refreshFiles,
    }),
    [
      files,
      visibleFiles,
      subAgentFiles,
      viewedSubAgent,
      animatingFileKeys,
      unseenFileCount,
      lightboxFileId,
      lightboxOrder,
      setLightboxFileId,
      openLightbox,
      refreshFiles,
    ]
  );
}
