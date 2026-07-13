import { type ClipboardEvent, useCallback, useRef, useState } from "react";

import {
  type ClipboardSuggestion,
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
  getClipboardSuggestion,
} from "@/components/app/create-agent-dialog-clipboard";

export function useContextPickerClipboard({
  onAppendFiles,
  onAddLink,
  onClipboardText,
}: {
  onAppendFiles: (files: File[]) => void;
  onAddLink: (normalizedUrl: string) => void;
  onClipboardText?: (text: string) => void;
}) {
  const clipboardRequestIdRef = useRef(0);
  const clipboardPasteRef = useRef<HTMLInputElement>(null);
  const pasteTooltipTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [clipboardPasteMode, setClipboardPasteMode] = useState(false);
  const [pasteTooltip, setPasteTooltip] = useState<string | null>(null);
  const [clipboardReadFeedback, setClipboardReadFeedback] = useState<
    string | null
  >(null);

  const applyClipboardSuggestion = useCallback(
    (suggestion: ClipboardSuggestion) => {
      switch (suggestion.kind) {
        case "image":
        case "file":
          onAppendFiles([suggestion.file]);
          break;
        case "url":
          onAddLink(suggestion.url);
          break;
        case "text":
          onClipboardText?.(suggestion.text);
          break;
      }
    },
    [onAppendFiles, onAddLink, onClipboardText]
  );

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    setClipboardReadFeedback(null);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      if (result.suggestion) {
        if (result.suggestion.kind === "text" && !onClipboardText) {
          setClipboardReadFeedback("Nothing readable found on the clipboard.");
        } else {
          applyClipboardSuggestion(result.suggestion);
        }
        return;
      }
      if (result.status === "blocked" || result.status === "unsupported") {
        setClipboardPasteMode(true);
        requestAnimationFrame(() => clipboardPasteRef.current?.focus());
      } else {
        setClipboardReadFeedback("Nothing readable found on the clipboard.");
      }
    });
  }, [applyClipboardSuggestion, onClipboardText]);

  const handleClipboardPasteInput = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        onAppendFiles(pastedFiles);
        setClipboardPasteMode(false);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        applyClipboardSuggestion(textSuggestion);
        setClipboardPasteMode(false);
        return;
      }
      if (onClipboardText && textSuggestion?.kind === "text") {
        onClipboardText(textSuggestion.text);
        setClipboardPasteMode(false);
        return;
      }
      clearTimeout(pasteTooltipTimerRef.current);
      setPasteTooltip("No files or images found");
      pasteTooltipTimerRef.current = setTimeout(
        () => setPasteTooltip(null),
        2500
      );
    },
    [onAppendFiles, applyClipboardSuggestion, onClipboardText]
  );

  const handleClipboardPasteBlur = useCallback(() => {
    setClipboardPasteMode(false);
    setPasteTooltip(null);
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        onAppendFiles(pastedFiles);
        setClipboardReadFeedback(null);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        applyClipboardSuggestion(textSuggestion);
        setClipboardReadFeedback(null);
      }
    },
    [onAppendFiles, applyClipboardSuggestion]
  );

  return {
    checking: checkingClipboard,
    pasteMode: clipboardPasteMode,
    pasteTooltip,
    readFeedback: clipboardReadFeedback,
    pasteRef: clipboardPasteRef,
    handleCheck: handleCheckClipboard,
    handlePasteInput: handleClipboardPasteInput,
    handlePasteBlur: handleClipboardPasteBlur,
    handlePaste,
  };
}
