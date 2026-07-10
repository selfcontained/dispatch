import { useCallback, useEffect, useRef, useState } from "react";
import { Tldraw, type Editor, type TLStoreSnapshot } from "tldraw";
import "tldraw/tldraw.css";

import { THEMES, type ThemeId } from "@/hooks/use-theme";
import {
  useWhiteboard,
  useSaveWhiteboard,
  useUploadWhiteboardSnapshot,
  type WhiteboardScene,
} from "@/hooks/use-whiteboard";

type WhiteboardTabProps = {
  agentId: string | null;
  theme: ThemeId;
};

function sceneToSnapshot(scene: WhiteboardScene): TLStoreSnapshot | undefined {
  if (!scene.records || scene.records.length === 0) return undefined;
  const store: Record<string, unknown> = {};
  for (const record of scene.records) {
    const id = record.id as string;
    if (id) store[id] = record;
  }
  return { store, schema: undefined } as unknown as TLStoreSnapshot;
}

const SAVE_DEBOUNCE_MS = 2000;
const SNAPSHOT_DEBOUNCE_MS = 4000;

export function WhiteboardTab({ agentId, theme }: WhiteboardTabProps) {
  const { data } = useWhiteboard(agentId);
  const saveMutation = useSaveWhiteboard(agentId);
  const snapshotMutation = useUploadWhiteboardSnapshot(agentId);
  const editorRef = useRef<Editor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerDownRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const lastSavedVersionRef = useRef(0);
  const [initialSnapshot] = useState(() =>
    data ? sceneToSnapshot(data.scene) : undefined
  );

  const themeMode = THEMES.find((t) => t.id === theme)?.mode ?? "dark";

  const debouncedSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const snapshot = editor.getSnapshot();
      const records = Object.values(
        snapshot.document.store
      ) as unknown as Record<string, unknown>[];
      saveMutation.mutate({ records });
    }, SAVE_DEBOUNCE_MS);
  }, [saveMutation]);

  const debouncedSnapshot = useCallback(() => {
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
    snapshotTimerRef.current = setTimeout(async () => {
      const editor = editorRef.current;
      if (!editor) return;
      const shapeIds = editor.getCurrentPageShapeIds();
      if (shapeIds.size === 0) return;
      try {
        const result = await editor.toImage([...shapeIds], {
          format: "png",
          background: true,
          padding: 16,
        });
        if (result.blob) snapshotMutation.mutate(result.blob);
      } catch {
        // export can fail if shapes aren't renderable yet
      }
    }, SNAPSHOT_DEBOUNCE_MS);
  }, [snapshotMutation]);

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;

      if (data && data.scene.records && data.scene.records.length > 0) {
        try {
          const snapshot = sceneToSnapshot(data.scene);
          if (snapshot) {
            editor.loadSnapshot(snapshot);
          }
        } catch {
          // failed to load, start fresh
        }
      }

      const handleChange = () => {
        if (pointerDownRef.current) {
          pendingSaveRef.current = true;
          return;
        }
        debouncedSave();
        debouncedSnapshot();
      };

      editor.store.listen(handleChange, { scope: "document", source: "user" });

      const handlePointerDown = () => {
        pointerDownRef.current = true;
      };
      const handlePointerUp = () => {
        pointerDownRef.current = false;
        if (pendingSaveRef.current) {
          pendingSaveRef.current = false;
          debouncedSave();
          debouncedSnapshot();
        }
      };

      const container = editor.getContainer();
      container.addEventListener("pointerdown", handlePointerDown);
      container.addEventListener("pointerup", handlePointerUp);
    },
    [data, debouncedSave, debouncedSnapshot]
  );

  useEffect(() => {
    if (!data || !editorRef.current) return;
    if (data.version <= lastSavedVersionRef.current) return;
    lastSavedVersionRef.current = data.version;
  }, [data]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current);
      const editor = editorRef.current;
      if (editor && pendingSaveRef.current) {
        const snapshot = editor.getSnapshot();
        const records = Object.values(
          snapshot.document.store
        ) as unknown as Record<string, unknown>[];
        saveMutation.mutate({ records });
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full w-full" data-testid="whiteboard-canvas">
      <Tldraw
        onMount={handleMount}
        snapshot={initialSnapshot}
        options={{ maxPages: 1 }}
        forceMobile={false}
        colorScheme={themeMode === "dark" ? "dark" : "light"}
        key={agentId}
      />
    </div>
  );
}
