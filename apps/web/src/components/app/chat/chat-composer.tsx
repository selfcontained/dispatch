import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CHAT_ATTACHMENTS_MAX, CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
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
import { useStartupAttachments } from "@/components/app/use-startup-attachments";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isAcceptedUploadFile } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

export type ChatComposerProps = {
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
  autoFocus?: boolean;
  /**
   * When set, what gets typed answers this question rather than starting a
   * plain message. The × lets the user opt out and send a plain message.
   */
  replyContext?: { excerpt: string; onDismiss: () => void } | null;
};

const NO_PINS: AgentPin[] = [];

/**
 * What went wrong, and whether pressing Enter again can help. A validation
 * error (unsupported file, attachment cap) is final until the user changes
 * something; an upload or send failure leaves a sendable draft behind, so
 * that one gets the retry hint.
 */
type ComposerError = { text: string; retryable: boolean };

const SUPPORTED_FILE_HINT =
  "Choose a supported file type: an image, video, PDF, or text file.";

/**
 * Enter sends, Shift+Enter inserts a newline. An in-progress IME composition
 * is left alone: the Enter that commits a CJK candidate must not send.
 *
 * Attachments ride along as chips above the field: files from the
 * paperclip, a drop or a paste; links from a pasted URL; pins from the pin
 * picker. Files upload when the message is sent, so an unsent draft leaves
 * nothing behind on the server.
 */
export function ChatComposer({
  onSend,
  uploadFile,
  pins = NO_PINS,
  disabledReason,
  sending = false,
  placeholder = "Message the agent…",
  autoFocus = false,
  replyContext = null,
}: ChatComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<ComposerError | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();

  // ---- attachments ----------------------------------------------------------
  const {
    startupFiles: files,
    startupLinks: links,
    draggingFiles,
    setDraggingFiles,
    startupFilePreviewsRef: previewsRef,
    appendStartupFiles,
    handleAddLink,
    handleRemoveStartupFile,
    handleRemoveStartupLink,
  } = useStartupAttachments();
  const [attachedPins, setAttachedPins] = useState<AgentPin[]>([]);
  // Per-file bookkeeping keyed by `startupFileKey`: the original text of a
  // long paste (for "keep inline"), the media id once uploaded (so a retry
  // after a later failure does not upload it twice), and the upload state.
  const pastedTextRef = useRef<Map<string, string>>(new Map());
  const mediaIdsRef = useRef<Map<string, number>>(new Map());
  const [fileStatus, setFileStatus] = useState<
    Record<string, "uploading" | "failed">
  >({});

  const attachmentCount = files.length + links.length + attachedPins.length;
  const attachmentsFull = attachmentCount >= CHAT_ATTACHMENTS_MAX;

  const noteAttachmentLimit = useCallback(() => {
    setError({
      text: `Up to ${CHAT_ATTACHMENTS_MAX} attachments per message.`,
      retryable: false,
    });
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
        const names = unsupported.map((f) => f.name).join(", ");
        setError({
          text: `${unsupported.length === 1 ? "Unsupported file type" : "Unsupported file types"}: ${names}. ${SUPPORTED_FILE_HINT}`,
          retryable: false,
        });
      } else {
        setError(null);
      }
      const room = Math.max(0, CHAT_ATTACHMENTS_MAX - attachmentCount);
      if (accepted.length > room) noteAttachmentLimit();
      appendStartupFiles(accepted.slice(0, room));
    },
    [appendStartupFiles, attachmentCount, noteAttachmentLimit]
  );

  const addLink = useCallback(
    (url: string) => {
      if (attachmentsFull && !links.includes(url)) {
        noteAttachmentLimit();
        return;
      }
      setError(null);
      handleAddLink(url);
    },
    [attachmentsFull, handleAddLink, links, noteAttachmentLimit]
  );

  const addPin = useCallback(
    (pin: AgentPin) => {
      if (!pin.id) return;
      setAttachedPins((current) => {
        if (current.some((p) => p.id === pin.id)) return current;
        if (attachmentsFull) {
          noteAttachmentLimit();
          return current;
        }
        return [...current, pin];
      });
    },
    [attachmentsFull, noteAttachmentLimit]
  );

  const removeFile = useCallback(
    (file: File) => {
      const key = startupFileKey(file);
      pastedTextRef.current.delete(key);
      mediaIdsRef.current.delete(key);
      setFileStatus((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      handleRemoveStartupFile(file);
    },
    [handleRemoveStartupFile]
  );

  const removePin = useCallback((pin: AgentPin) => {
    setAttachedPins((current) => current.filter((p) => p.id !== pin.id));
  }, []);

  const addPastedText = useCallback(
    (pasted: string) => {
      if (attachmentsFull) {
        noteAttachmentLimit();
        return false;
      }
      const file = pastedTextFile(
        pasted,
        nextPastedFileName(files.map((f) => f.name))
      );
      pastedTextRef.current.set(startupFileKey(file), pasted);
      setError(null);
      appendStartupFiles([file]);
      return true;
    },
    [appendStartupFiles, attachmentsFull, files, noteAttachmentLimit]
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
    [removeFile]
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
    [disabled, setDraggingFiles]
  );

  const onDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setDraggingFiles(false);
    },
    [setDraggingFiles]
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      setDraggingFiles(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer.files ?? []);
      if (dropped.length === 0) return;
      event.preventDefault();
      // Route through addFiles for the accept filter and the cap; the hook's
      // own drop handler would append them unfiltered.
      addFiles(dropped);
    },
    [addFiles, disabled, setDraggingFiles]
  );

  const attachedPinIds = useMemo(
    () => new Set(attachedPins.map((pin) => pin.id!)),
    [attachedPins]
  );

  const canSend =
    !disabled &&
    !sending &&
    !inFlight &&
    (trimmed.length > 0 || attachmentCount > 0);

  // Grow with the content up to the CSS max-height, then scroll inside.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

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
        setText((current) => (current === submittedText ? "" : current));
        for (const file of submittedFiles) removeFile(file);
        for (const url of submittedLinks) handleRemoveStartupLink(url);
        setAttachedPins((current) =>
          current.filter((pin) => !submittedPins.includes(pin))
        );
      })
      .catch((err: unknown) => {
        // The draft — text and chips — is still here, so a retry can work.
        setError({
          text: err instanceof Error ? err.message : "Message not sent.",
          retryable: true,
        });
      })
      .finally(() => {
        setInFlight(false);
        textareaRef.current?.focus();
      });
  }, [
    attachedPins,
    canSend,
    files,
    handleRemoveStartupLink,
    links,
    onSend,
    removeFile,
    text,
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
            // Bounded: at the 20-attachment cap the chips scroll inside
            // this strip instead of pushing the field and Send off-screen.
            className="flex max-h-40 flex-wrap items-start gap-3 overflow-y-auto px-3 pb-1 pt-3"
            data-testid="chat-composer-attachments"
          >
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
                onRemove={() => handleRemoveStartupLink(link)}
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
            data-retryable={error.retryable ? "true" : undefined}
          >
            {error.retryable
              ? `${error.text} — your message is still here; press Enter to try again.`
              : error.text}
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
