import {
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { startupFileKey } from "@/components/app/create-agent-dialog-clipboard";

export function useStartupAttachments() {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const startupFilePreviewsRef = useRef<Map<string, string>>(new Map());

  const appendStartupFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setStartupFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map(startupFileKey));
      for (const file of files) {
        const key = startupFileKey(file);
        if (seen.has(key)) continue;
        if (next.length >= 10) {
          setAttachmentError("A maximum of 10 startup files is allowed.");
          break;
        }
        seen.add(key);
        next.push(file);
        if (
          file.type.startsWith("image/") &&
          !startupFilePreviewsRef.current.has(key)
        ) {
          startupFilePreviewsRef.current.set(key, URL.createObjectURL(file));
        }
      }
      return next;
    });
  }, []);

  const handleAddLink = useCallback((url: string) => {
    setStartupLinks((current) =>
      current.includes(url) ? current : [...current, url]
    );
  }, []);

  const handleRemoveStartupFile = useCallback((fileToRemove: File) => {
    const key = startupFileKey(fileToRemove);
    const url = startupFilePreviewsRef.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      startupFilePreviewsRef.current.delete(key);
    }
    setAttachmentError(null);
    setStartupFiles((current) =>
      current.filter((file) => startupFileKey(file) !== key)
    );
  }, []);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const handleStartupDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingFiles(false);
      appendStartupFiles(droppedFiles);
    },
    [appendStartupFiles]
  );

  useEffect(() => {
    const previews = startupFilePreviewsRef.current;
    return () => {
      for (const url of previews.values()) {
        URL.revokeObjectURL(url);
      }
      previews.clear();
    };
  }, []);

  const resetAttachments = useCallback(() => {
    for (const url of startupFilePreviewsRef.current.values())
      URL.revokeObjectURL(url);
    startupFilePreviewsRef.current.clear();
    setStartupFiles([]);
    setStartupLinks([]);
    setDraggingFiles(false);
    setAttachmentError(null);
  }, []);

  return {
    attachmentError,
    resetAttachments,
    startupFiles,
    startupLinks,
    draggingFiles,
    setDraggingFiles,
    startupFilePreviewsRef,
    appendStartupFiles,
    handleAddLink,
    handleRemoveStartupFile,
    handleRemoveStartupLink,
    handleStartupDrop,
  };
}
