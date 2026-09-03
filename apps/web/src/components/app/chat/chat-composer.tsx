import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CHAT_ATTACHMENTS_MAX, CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
import { atom, useAtom } from "jotai";
import { CornerDownRight, Paperclip, SendHorizontal, X } from "lucide-react";

import {
  type ChatUserAttachmentInput,
  countLines,
  isLongPaste,
  nextPastedFileName,
  pastedLinkUrl,
  pastedTextFile,
} from "@/components/app/chat/chat-attachments";
import {
  DraftPlaceholderChip,
  PastedTextChip,
  PinChip,
  PinPickerButton,
} from "@/components/app/chat/chat-composer-attachments";
import {
  ContextFileItem,
  ContextLinkItem,
} from "@/components/app/context-picker-items";
import {
  STARTUP_FILE_ACCEPT,
  getClipboardFilesFromEvent,
  startupFileKey,
} from "@/components/app/create-agent-dialog-clipboard";
import { type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type ChatComposerDraft,
  type ChatDraftFile,
  EMPTY_CHAT_DRAFT,
  fitChatDraft,
  isChatComposerDraft,
} from "@/lib/chat-draft";
import { isAcceptedUploadFile } from "@/lib/media-upload";
import { chatDraftAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

export type ChatComposerProps = {
  /**
   * Keys the persisted draft. With no agent the draft lives in memory only
   * and is dropped on unmount.
   */
  agentId: string | null;
  /**
   * Resolves once the message is accepted; rejects when it is not. The draft
   * — text and attachments — is cleared only on success so a failed send
   * never eats what was typed.
   */
  onSend: (
    text: string,
    attachments: ChatUserAttachmentInput[]
  ) => Promise<void>;
  /**
   * Uploads one attached file and resolves to its media id. Called at send
   * time, once per file; a rejection keeps the draft and marks the chip.
   */
  uploadFile?: (file: File) => Promise<{ id: number }>;
  /** The agent's pins, for the pin picker. */
  pins?: AgentPin[];
  /** When set, the composer is disabled and this explains why. */
  disabledReason: string | null;
  /** An external send is in flight; the input stays usable, the button waits. */
  sending?: boolean;
  placeholder?: string;
  /**
   * Focus the field on mount, and again whenever this turns true — the
   * composer stays mounted under the Console view, so a flip back to Chat
   * arrives as a prop change, not a mount.
   */
  autoFocus?: boolean;
  /**
   * When set, what gets typed answers this question rather than starting a
   * plain message. The × lets the user opt out and send a plain message.
   */
  replyContext?: { excerpt: string; onDismiss: () => void } | null;
};

const NO_PINS: AgentPin[] = [];

/** What is kept of a live file across a reload: its identity, and a paste's text. */
function describeFile(file: File, pasted: string | undefined): ChatDraftFile {
  return {
    name: file.name,
    size: file.size,
    mime: file.type,
    ...(pasted !== undefined ? { pasted } : {}),
  };
}

function sameFiles(a: ChatDraftFile[], b: ChatDraftFile[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Splits a stored draft's files into what can come back live (a pasted text
 * chip whose body was kept) and what can only be a placeholder (a picked
 * file, or a paste whose body was dropped for size).
 */
function restoreDraftFiles(draft: ChatComposerDraft): {
  files: File[];
  pasted: Map<string, string>;
  placeholders: ChatDraftFile[];
} {
  const files: File[] = [];
  const pasted = new Map<string, string>();
  const placeholders: ChatDraftFile[] = [];
  for (const entry of draft.files) {
    if (typeof entry.pasted === "string") {
      const file = pastedTextFile(entry.pasted, entry.name);
      pasted.set(startupFileKey(file), entry.pasted);
      files.push(file);
    } else {
      placeholders.push(entry);
    }
  }
  return { files, pasted, placeholders };
}

/**
 * Enter sends, Shift+Enter inserts a newline. An in-progress IME composition
 * is left alone: the Enter that commits a CJK candidate must not send.
 *
 * Attachments ride along as chips above the field: files from the
 * paperclip, a drop or a paste; links from a pasted URL; pins from the pin
 * picker. Files upload when the message is sent, so an unsent draft leaves
 * nothing behind on the server.
 *
 * The draft — text, links, pins, pasted text — is persisted per agent
 * (`chatDraftAtomFamily`) and comes back after a reload. Picked files
 * cannot: they come back as "needs re-attaching" placeholders that hold the
 * send until they are re-attached or removed.
 */
export function ChatComposer({
  agentId,
  onSend,
  uploadFile,
  pins = NO_PINS,
  disabledReason,
  sending = false,
  placeholder = "Message the agent…",
  autoFocus = false,
  replyContext = null,
}: ChatComposerProps): JSX.Element {
  // No agent: an atom of this mount's own, so nothing outlives the composer.
  const [localDraftAtom] = useState(() =>
    atom<ChatComposerDraft>(EMPTY_CHAT_DRAFT)
  );
  const [storedDraft, setStoredDraft] = useAtom(
    agentId ? chatDraftAtomFamily(agentId) : localDraftAtom
  );
  const draft = isChatComposerDraft(storedDraft)
    ? storedDraft
    : EMPTY_CHAT_DRAFT;
  const updateDraft = useCallback(
    (patch: (current: ChatComposerDraft) => ChatComposerDraft) => {
      setStoredDraft((prev) =>
        fitChatDraft(patch(isChatComposerDraft(prev) ? prev : EMPTY_CHAT_DRAFT))
      );
    },
    [setStoredDraft]
  );
  const { text, links, pinIds } = draft;
  const setText = useCallback(
    (next: string | ((current: string) => string)) => {
      updateDraft((current) => ({
        ...current,
        text: typeof next === "function" ? next(current.text) : next,
      }));
    },
    [updateDraft]
  );

  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();

  // ---- files: live File objects, in memory only -----------------------------
  // Restored once, from the draft as it was on mount; from then on the draft's
  // file list mirrors this state (see the sync effect below).
  const [restored] = useState(() => restoreDraftFiles(draft));
  const [files, setFiles] = useState<File[]>(restored.files);
  const [placeholders, setPlaceholders] = useState<ChatDraftFile[]>(
    restored.placeholders
  );
  // Per-file bookkeeping keyed by `startupFileKey`: the original text of a
  // long paste (for "keep inline" and for persistence), the media id once
  // uploaded (so a retry after a later failure does not upload it twice),
  // image previews, and the upload state.
  const pastedTextRef = useRef<Map<string, string>>(restored.pasted);
  const mediaIdsRef = useRef<Map<string, number>>(new Map());
  const previewsRef = useRef<Map<string, string>>(new Map());
  const [fileStatus, setFileStatus] = useState<
    Record<string, "uploading" | "failed">
  >({});
  const [draggingFiles, setDraggingFiles] = useState(false);

  useEffect(() => {
    const previews = previewsRef.current;
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
    };
  }, []);

  useEffect(() => {
    const described = [
      ...placeholders,
      ...files.map((file) =>
        describeFile(file, pastedTextRef.current.get(startupFileKey(file)))
      ),
    ];
    updateDraft((current) =>
      sameFiles(current.files, described)
        ? current
        : { ...current, files: described }
    );
  }, [files, placeholders, updateDraft]);

  const appendFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    setFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map(startupFileKey));
      for (const file of incoming) {
        const key = startupFileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(file);
        if (file.type.startsWith("image/") && !previewsRef.current.has(key)) {
          previewsRef.current.set(key, URL.createObjectURL(file));
        }
      }
      return next;
    });
  }, []);

  const attachedPins = useMemo(
    () =>
      pinIds
        .map((id) => pins.find((pin) => pin.id === id))
        .filter((pin): pin is AgentPin => pin !== undefined),
    [pinIds, pins]
  );
  const attachmentCount =
    files.length + placeholders.length + links.length + attachedPins.length;
  const attachmentsFull = attachmentCount >= CHAT_ATTACHMENTS_MAX;

  const noteAttachmentLimit = useCallback(() => {
    setError(`Up to ${CHAT_ATTACHMENTS_MAX} attachments per message.`);
  }, []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const unsupported = incoming.filter(
        (file) => !isAcceptedUploadFile(file.name)
      );
      const accepted = incoming.filter((file) =>
        isAcceptedUploadFile(file.name)
      );
      if (unsupported.length > 0) {
        setError(
          unsupported.length === 1
            ? `Unsupported file type: ${unsupported[0]!.name}`
            : `Unsupported file types: ${unsupported.map((f) => f.name).join(", ")}`
        );
      } else {
        setError(null);
      }
      const room = Math.max(0, CHAT_ATTACHMENTS_MAX - attachmentCount);
      if (accepted.length > room) noteAttachmentLimit();
      appendFiles(accepted.slice(0, room));
    },
    [appendFiles, attachmentCount, noteAttachmentLimit]
  );

  const addLink = useCallback(
    (url: string) => {
      if (attachmentsFull && !links.includes(url)) {
        noteAttachmentLimit();
        return;
      }
      setError(null);
      updateDraft((current) =>
        current.links.includes(url)
          ? current
          : { ...current, links: [...current.links, url] }
      );
    },
    [attachmentsFull, links, noteAttachmentLimit, updateDraft]
  );

  const removeLink = useCallback(
    (url: string) => {
      updateDraft((current) => ({
        ...current,
        links: current.links.filter((link) => link !== url),
      }));
    },
    [updateDraft]
  );

  const addPin = useCallback(
    (pin: AgentPin) => {
      if (!pin.id) return;
      if (pinIds.includes(pin.id)) return;
      if (attachmentsFull) {
        noteAttachmentLimit();
        return;
      }
      updateDraft((current) =>
        current.pinIds.includes(pin.id!)
          ? current
          : { ...current, pinIds: [...current.pinIds, pin.id!] }
      );
    },
    [attachmentsFull, noteAttachmentLimit, pinIds, updateDraft]
  );

  const removePin = useCallback(
    (pin: AgentPin) => {
      updateDraft((current) => ({
        ...current,
        pinIds: current.pinIds.filter((id) => id !== pin.id),
      }));
    },
    [updateDraft]
  );

  const removeFile = useCallback((file: File) => {
    const key = startupFileKey(file);
    pastedTextRef.current.delete(key);
    mediaIdsRef.current.delete(key);
    const preview = previewsRef.current.get(key);
    if (preview) {
      URL.revokeObjectURL(preview);
      previewsRef.current.delete(key);
    }
    setFileStatus((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setFiles((current) =>
      current.filter((candidate) => startupFileKey(candidate) !== key)
    );
  }, []);

  const removePlaceholder = useCallback((index: number) => {
    setPlaceholders((current) => current.filter((_, i) => i !== index));
  }, []);

  const addPastedText = useCallback(
    (pasted: string) => {
      if (attachmentsFull) {
        noteAttachmentLimit();
        return false;
      }
      const file = pastedTextFile(
        pasted,
        nextPastedFileName([
          ...files.map((f) => f.name),
          ...placeholders.map((f) => f.name),
        ])
      );
      pastedTextRef.current.set(startupFileKey(file), pasted);
      setError(null);
      appendFiles([file]);
      return true;
    },
    [appendFiles, attachmentsFull, files, noteAttachmentLimit, placeholders]
  );

  /** Undo for a long paste: drop the chip, put the text back in the field. */
  const keepInline = useCallback(
    (file: File) => {
      const pasted = pastedTextRef.current.get(startupFileKey(file)) ?? "";
      removeFile(file);
      const el = textareaRef.current;
      setText((current) => {
        const start = el?.selectionStart ?? current.length;
        const end = el?.selectionEnd ?? current.length;
        return current.slice(0, start) + pasted + current.slice(end);
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [removeFile, setText]
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        addFiles(pastedFiles);
        return;
      }
      const pasted = event.clipboardData.getData("text/plain");
      const url = pastedLinkUrl(pasted);
      if (url) {
        event.preventDefault();
        addLink(url);
        return;
      }
      if (isLongPaste(pasted) && addPastedText(pasted)) {
        event.preventDefault();
      }
    },
    [addFiles, addLink, addPastedText, disabled]
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    },
    [addFiles]
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (disabled) return;
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDraggingFiles(true);
    },
    [disabled]
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDraggingFiles(false);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      setDraggingFiles(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer.files ?? []);
      if (dropped.length === 0) return;
      event.preventDefault();
      addFiles(dropped);
    },
    [addFiles, disabled]
  );

  const attachedPinIds = useMemo(
    () => new Set(attachedPins.map((pin) => pin.id!)),
    [attachedPins]
  );

  const canSend =
    !disabled &&
    !sending &&
    !inFlight &&
    placeholders.length === 0 &&
    (trimmed.length > 0 || attachmentCount > 0);

  // Grow with the content up to the CSS max-height, then scroll inside.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = useCallback(() => {
    if (!canSend) return;
    setError(null);
    setInFlight(true);
    // Only what was sent gets cleared: anything typed or attached while the
    // send was pending is a new draft and stays.
    const submittedText = text;
    const submittedFiles = files;
    const submittedLinks = links;
    const submittedPins = attachedPins;

    const run = async () => {
      const attachments: ChatUserAttachmentInput[] = [];
      for (const file of submittedFiles) {
        const key = startupFileKey(file);
        let mediaId = mediaIdsRef.current.get(key);
        if (mediaId === undefined) {
          if (!uploadFile) throw new Error("File uploads are not available.");
          setFileStatus((current) => ({ ...current, [key]: "uploading" }));
          try {
            const media = await uploadFile(file);
            mediaId = media.id;
            mediaIdsRef.current.set(key, mediaId);
            setFileStatus((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
          } catch (err) {
            setFileStatus((current) => ({ ...current, [key]: "failed" }));
            const reason = err instanceof Error ? err.message : "";
            throw new Error(
              `Couldn't upload ${file.name}${reason ? `: ${reason}` : ""}`
            );
          }
        }
        attachments.push({ type: "file", mediaId });
      }
      for (const url of submittedLinks) attachments.push({ type: "link", url });
      for (const pin of submittedPins) {
        attachments.push({ type: "pin", pinId: pin.id! });
      }
      await onSend(submittedText.trim(), attachments);
    };

    run()
      .then(() => {
        const sentPinIds = new Set(submittedPins.map((pin) => pin.id));
        updateDraft((current) => ({
          ...current,
          text: current.text === submittedText ? "" : current.text,
          links: current.links.filter((url) => !submittedLinks.includes(url)),
          pinIds: current.pinIds.filter((id) => !sentPinIds.has(id)),
        }));
        for (const file of submittedFiles) removeFile(file);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Message not sent.");
      })
      .finally(() => {
        setInFlight(false);
        textareaRef.current?.focus();
      });
  }, [
    attachedPins,
    canSend,
    files,
    links,
    onSend,
    removeFile,
    text,
    updateDraft,
    uploadFile,
  ]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") return;
      if (event.shiftKey) return;
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const uploadingName = files.find(
    (file) => fileStatus[startupFileKey(file)] === "uploading"
  )?.name;
  const hasAttachments = attachmentCount > 0;

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="chat-composer"
      data-dragging={draggingFiles ? "true" : undefined}
    >
      <div
        className={cn(
          "rounded-lg border bg-card/70 transition-colors",
          disabled
            ? "border-border opacity-70"
            : draggingFiles
              ? "border-status-done bg-status-done/10 ring-1 ring-inset ring-status-done/30"
              : "border-border focus-within:border-foreground/30 hover:border-foreground/20"
        )}
      >
        {replyContext && !disabled ? (
          <div className="px-2 pt-2">
            <div
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-status-waiting/40 bg-status-waiting/10 py-0.5 pl-2 pr-1 text-[11px] text-foreground"
              data-testid="chat-reply-context"
            >
              <CornerDownRight className="h-3 w-3 shrink-0 text-status-waiting" />
              <span className="shrink-0 text-muted-foreground">
                Replying to:
              </span>
              <span className="max-w-[40ch] truncate">
                {replyContext.excerpt}
              </span>
              <button
                type="button"
                onClick={replyContext.onDismiss}
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Send a plain message instead"
                aria-label="Send a plain message instead"
                data-testid="chat-reply-context-dismiss"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        ) : null}
        {hasAttachments ? (
          <div
            className="flex flex-wrap items-start gap-3 px-3 pb-1 pt-3"
            data-testid="chat-composer-attachments"
          >
            {placeholders.map((entry, index) => (
              <DraftPlaceholderChip
                key={`placeholder:${entry.name}:${index}`}
                entry={entry}
                onRemove={() => removePlaceholder(index)}
              />
            ))}
            {files.map((file) => {
              const key = startupFileKey(file);
              const pasted = pastedTextRef.current.get(key);
              return pasted !== undefined ? (
                <PastedTextChip
                  key={key}
                  file={file}
                  lines={countLines(pasted)}
                  status={fileStatus[key]}
                  onKeepInline={() => keepInline(file)}
                  onRemove={() => removeFile(file)}
                />
              ) : (
                <ContextFileItem
                  key={key}
                  file={file}
                  preview={previewsRef.current.get(key)}
                  status={fileStatus[key]}
                  onRemove={() => removeFile(file)}
                />
              );
            })}
            {links.map((link) => (
              <ContextLinkItem
                key={link}
                link={link}
                onRemove={() => removeLink(link)}
              />
            ))}
            {attachedPins.map((pin) => (
              <PinChip key={pin.id} pin={pin} onRemove={() => removePin(pin)} />
            ))}
          </div>
        ) : null}
        <div className="flex items-end">
          <div className="flex shrink-0 items-center gap-0.5 pb-1.5 pl-1.5 pointer-coarse:pb-0 pointer-coarse:pl-0">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={STARTUP_FILE_ACCEPT}
              className="hidden"
              onChange={onFileChange}
              data-testid="chat-composer-file-input"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled || attachmentsFull}
              onClick={() => fileInputRef.current?.click()}
              title="Attach a file"
              aria-label="Attach a file"
              data-testid="chat-composer-attach-button"
              className="h-7 w-7 shrink-0 text-muted-foreground pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:w-11 pointer-coarse:min-w-11"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <PinPickerButton
              pins={pins}
              attachedIds={attachedPinIds}
              disabled={disabled || attachmentsFull}
              onPick={addPin}
            />
          </div>
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            rows={1}
            maxLength={CHAT_MESSAGE_MAX_CHARS}
            autoFocus={autoFocus}
            placeholder={
              disabled ? "" : replyContext ? "Type your answer…" : placeholder
            }
            aria-label="Message the agent"
            // The box around it is the border; the field itself is bare.
            className="max-h-48 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm shadow-none backdrop-blur-none focus-visible:ring-0"
            data-testid="chat-composer-input"
          />
          <Button
            type="submit"
            size="icon"
            variant={canSend ? "primary" : "ghost"}
            disabled={!canSend}
            title="Send (Enter)"
            aria-label="Send message"
            data-testid="chat-composer-send"
            // Compact icon under a mouse; on touch devices the button grows
            // to a 44px target and drops its inset so it still sits inside
            // the composer box next to the 40px-min field.
            className="m-1.5 h-7 w-7 shrink-0 pointer-coarse:m-0 pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:w-11 pointer-coarse:min-w-11"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="px-1 text-[10px] text-muted-foreground">
        {disabledReason ? (
          <span data-testid="chat-composer-disabled-reason">
            {disabledReason}
          </span>
        ) : error ? (
          <span
            role="alert"
            className="text-destructive"
            data-testid="chat-composer-error"
          >
            {error} — your message is still here; press Enter to try again.
          </span>
        ) : placeholders.length > 0 ? (
          <span data-testid="chat-composer-reattach-hint">
            {placeholders.length === 1
              ? `Re-attach or remove ${placeholders[0]!.name} to send.`
              : `Re-attach or remove ${placeholders.length} files to send.`}
          </span>
        ) : uploadingName ? (
          <span data-testid="chat-composer-uploading">
            Uploading {uploadingName}…
          </span>
        ) : draggingFiles ? (
          <span>Drop files to attach them</span>
        ) : (
          <span>
            Enter to send · Shift+Enter for a new line · paste or drop files
          </span>
        )}
      </div>
    </form>
  );
}
