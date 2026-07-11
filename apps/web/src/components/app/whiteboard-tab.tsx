import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Excalidraw,
  exportToBlob,
  getSceneVersion,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";

import {
  useWhiteboard,
  whiteboardQueryKey,
  type WhiteboardData,
} from "@/hooks/use-whiteboard";
import { getThemeMode, useTheme } from "@/hooks/use-theme";
import { api } from "@/lib/api";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";

const SAVE_DEBOUNCE_MS = 1000;
const SNAPSHOT_DEBOUNCE_MS = 4000;

type WhiteboardTabProps = {
  agentId: string;
  visible: boolean;
};

export default function WhiteboardTab({
  agentId,
  visible,
}: WhiteboardTabProps): JSX.Element {
  const { data, isLoading, isError } = useWhiteboard(agentId);

  if (isLoading || (!data && !isError)) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading whiteboard…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Could not load the whiteboard.
      </div>
    );
  }
  return (
    <WhiteboardCanvas agentId={agentId} initial={data} visible={visible} />
  );
}

function WhiteboardCanvas({
  agentId,
  initial,
  visible,
}: {
  agentId: string;
  initial: WhiteboardData;
  visible: boolean;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { theme } = useTheme();
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [boardEmpty, setBoardEmpty] = useState(
    initial.scene.elements.length === 0
  );
  const { data } = useWhiteboard(agentId);

  const versionRef = useRef(initial.version);
  const sceneVersionRef = useRef(
    getSceneVersion(initial.scene.elements as readonly ExcalidrawElement[])
  );
  const saveTimerRef = useRef<number | undefined>(undefined);
  const snapshotTimerRef = useRef<number | undefined>(undefined);
  const savingRef = useRef(false);
  const pointerDownRef = useRef(false);
  const pendingRemoteRef = useRef<WhiteboardData | null>(null);

  const initialData = useMemo<ExcalidrawInitialDataState>(
    () => ({
      elements: initial.scene.elements as readonly ExcalidrawElement[],
      scrollToContent: true,
    }),
    [initial]
  );

  const persistSnapshot = useCallback(async () => {
    if (!excalidrawAPI) return;
    const elements = excalidrawAPI.getSceneElements();
    if (elements.length === 0) {
      try {
        await api(`/api/v1/agents/${agentId}/whiteboard/snapshot`, {
          method: "DELETE",
        });
      } catch {}
      return;
    }
    try {
      const blob = await exportToBlob({
        elements,
        appState: {
          ...excalidrawAPI.getAppState(),
          exportBackground: true,
        },
        files: excalidrawAPI.getFiles(),
        mimeType: "image/png",
      });
      const form = new FormData();
      form.append("file", blob, "whiteboard.png");
      await api(`/api/v1/agents/${agentId}/whiteboard/snapshot`, {
        method: "POST",
        body: form,
      });
    } catch {
      // Snapshot is best-effort; the scene itself is already persisted.
    }
  }, [agentId, excalidrawAPI]);

  const persistScene = useCallback(async () => {
    if (!excalidrawAPI || savingRef.current) return;
    const elements = excalidrawAPI.getSceneElements();
    const sceneVersion = getSceneVersion(elements);
    if (sceneVersion === sceneVersionRef.current) return;
    savingRef.current = true;
    try {
      const res = await api<{ version: number }>(
        `/api/v1/agents/${agentId}/whiteboard`,
        {
          method: "PUT",
          body: JSON.stringify({
            scene: { elements },
            baseVersion: versionRef.current,
          }),
        }
      );
      versionRef.current = res.version;
      sceneVersionRef.current = sceneVersion;
      queryClient.setQueryData<WhiteboardData>(
        whiteboardQueryKey(agentId),
        (old) =>
          old
            ? {
                ...old,
                scene: { elements: [...elements] },
                version: res.version,
              }
            : old
      );
      if (snapshotTimerRef.current !== undefined) {
        window.clearTimeout(snapshotTimerRef.current);
      }
      snapshotTimerRef.current = window.setTimeout(() => {
        void persistSnapshot();
      }, SNAPSHOT_DEBOUNCE_MS);
    } catch {
      void queryClient.invalidateQueries({
        queryKey: whiteboardQueryKey(agentId),
        exact: true,
      });
    } finally {
      savingRef.current = false;
    }
  }, [agentId, excalidrawAPI, persistSnapshot, queryClient]);

  const scheduleSave = useCallback(() => {
    if (excalidrawAPI) {
      setBoardEmpty(excalidrawAPI.getSceneElements().length === 0);
    }
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      void persistScene();
    }, SAVE_DEBOUNCE_MS);
  }, [excalidrawAPI, persistScene]);

  const applyRemote = useCallback(
    (remote: WhiteboardData) => {
      if (!excalidrawAPI) return;
      const hydrated = restoreElements(
        remote.scene.elements as ExcalidrawElement[],
        excalidrawAPI.getSceneElements(),
        { repairBindings: true }
      );
      versionRef.current = remote.version;
      sceneVersionRef.current = getSceneVersion(hydrated);
      excalidrawAPI.updateScene({ elements: hydrated });
      setBoardEmpty(hydrated.length === 0);
      if (snapshotTimerRef.current !== undefined) {
        window.clearTimeout(snapshotTimerRef.current);
      }
      snapshotTimerRef.current = window.setTimeout(() => {
        void persistSnapshot();
      }, SNAPSHOT_DEBOUNCE_MS);
    },
    [excalidrawAPI, persistSnapshot]
  );

  useEffect(() => {
    if (!data || data.version <= versionRef.current) return;
    if (pointerDownRef.current) {
      pendingRemoteRef.current = data;
      return;
    }
    applyRemote(data);
  }, [data, applyRemote]);

  useEffect(() => {
    const onPointerUp = () => {
      pointerDownRef.current = false;
      const pending = pendingRemoteRef.current;
      if (pending) {
        pendingRemoteRef.current = null;
        applyRemote(pending);
      }
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, [applyRemote]);

  useEffect(() => {
    if (visible && excalidrawAPI) {
      excalidrawAPI.refresh();
    }
  }, [visible, excalidrawAPI]);

  useEffect(() => {
    if (visible) return;
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      void persistScene();
    }
  }, [visible, persistScene]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
        void persistScene();
      }
      if (snapshotTimerRef.current !== undefined) {
        window.clearTimeout(snapshotTimerRef.current);
        void persistSnapshot();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="relative h-full"
      data-testid="whiteboard-canvas"
      onPointerDownCapture={() => {
        pointerDownRef.current = true;
      }}
    >
      {boardEmpty ? (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center"
          data-testid="whiteboard-empty-hint"
        >
          <p className="max-w-md rounded-lg border border-border/60 bg-background/80 px-4 py-2 text-center text-sm text-muted-foreground backdrop-blur">
            Sketch here — your agent can see this board. Ask it to &ldquo;look
            at the whiteboard&rdquo; in the terminal.
          </p>
        </div>
      ) : null}
      <Excalidraw
        excalidrawAPI={setExcalidrawAPI}
        initialData={initialData}
        theme={getThemeMode(theme)}
        onChange={scheduleSave}
        UIOptions={{
          canvasActions: {
            toggleTheme: false,
          },
        }}
      />
    </div>
  );
}
