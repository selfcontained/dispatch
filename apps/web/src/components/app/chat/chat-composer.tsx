import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
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
} from "@/components/app/chat/chat-composer-attachments";
import {
  ContextFileItem,
  ContextLinkItem,
} from "@/components/app/context-picker-items";
import {
  STARTUP_FILE_ACCEPT,
  getClipboardFilesFromEvent,
} from "@/components/app/create-agent-dialog-clipboard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type ChatComposerDraft,
  type ChatDraftFile,
  EMPTY_CHAT_DRAFT,
  readChatComposerDraft,
} from "@/lib/chat-draft";
import { isImageFile } from "@/lib/media-accept";
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
  /**
   * Slash-menu entries. Typing "/" as the first character opens a picker
   * over them; picking one puts "/<name> " in the field. Nothing is sent
   * on its own — the host decides what a "/name" message means.
   */
  slashItems?: SlashItem[];
  /**
   * Called when a command item (`command: true`) is picked, with its name.
   * Return true to consume it — the field is cleared instead of filled.
   */
  onSlashCommand?: (name: string) => boolean;
  /**
   * An element beyond the composer that also takes file drops — the whole
   * pane, so a file dropped anywhere on the conversation attaches here.
   */
  dropTargetRef?: RefObject<HTMLElement | null>;
  /** Reports drag-over state of `dropTargetRef` for the host's overlay. */
  onDropZoneDragging?: (dragging: boolean) => void;
};

export type SlashItem = {
  name: string;
  description?: string;
  /** Picking it runs `onSlashCommand` rather than filling "/name ". */
  command?: boolean;
};

const SLASH_MENU_MAX = 8;

/** The "/query" the field holds while the menu should be open, else null. */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? m[1] : null;
}

export function filterSlashItems(
  items: SlashItem[],
  query: string
): SlashItem[] {
  const q = query.toLowerCase();
  const names = items.map((i) => [i, i.name.toLowerCase()] as const);
  const starts = names.filter(([, n]) => n.startsWith(q)).map(([i]) => i);
  const contains = names
    .filter(([, n]) => !n.startsWith(q) && n.includes(q))
    .map(([i]) => i);
  return [...starts, ...contains].slice(0, SLASH_MENU_MAX);
}

/** What is kept of a live file across a reload: its identity, and a paste's text. */
function describeFile(file: File, pasted?: string): ChatDraftFile {
  return {
    name: file.name,
    size: file.size,
    mime: file.type,
    ...(pasted !== undefined ? { pasted } : {}),
  };
}

/**
 * Identity of a draft file entry, and of the live `File` standing behind it
 * (`describeFile` of the `File` gives the same key). Keys the in-memory
 * bookkeeping: live files, previews, media ids, upload state.
 */
function draftFileKey(entry: ChatDraftFile): string {
  return `${entry.name}:${entry.size}:${entry.mime}`;
}

/**
 * Whether a file gets a thumbnail. By name as well as by MIME type: a file
 * pasted from the clipboard can arrive as `image.png` with an empty `type`
 * (WebKit, and some Chrome paste paths), and the upload route types it by
 * extension anyway.
 */
function isImageAttachment(file: File): boolean {
  return isImageFile(file.name) || file.type.startsWith("image/");
}

/**
 * A stored descriptor and a live file are the same attachment when name and
 * size agree — and the MIME type too, when both sides know it (a picked
 * file of an unregistered type reports none).
 */
function describesFile(entry: ChatDraftFile, file: File): boolean {
  return (
    entry.name === file.name &&
    entry.size === file.size &&
    (entry.mime === "" || file.type === "" || entry.mime === file.type)
  );
}

/** One draft file as rendered: its entry, its key, and its live `File` if any. */
type DraftFileView = {
  entry: ChatDraftFile;
  key: string;
  /** Absent for a placeholder: a file this tab has no bytes for. */
  file: File | undefined;
};

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
 * paperclip, a drop or a paste; links from a pasted URL. Files upload when
 * the message is sent, so an unsent draft leaves nothing behind on the
 * server.
 *
 * The draft — text, links, file descriptors, pasted text — is persisted per
 * agent (`chatDraftAtomFamily`) and is the one source of truth for what is
 * attached: chips render straight from `draft.files`. The bytes of a picked
 * file live only in a ref, keyed by `draftFileKey`, and never round-trip
 * through the draft. A descriptor this tab has no `File` for — after a
 * reload, or written by another tab — renders as a "needs re-attaching"
 * placeholder that holds the send until it is re-attached (which fills the
 * same slot) or removed. Nothing here writes the draft from an effect: every
 * change is one explicit write from the handler that caused it.
 */
export function ChatComposer({
  agentId,
  onSend,
  uploadFile,
  disabledReason,
  sending = false,
  placeholder = "Message the agent…",
  autoFocus = false,
  replyContext = null,
  slashItems,
  onSlashCommand,
  dropTargetRef,
  onDropZoneDragging,
}: ChatComposerProps): JSX.Element {
  // No agent: an atom of this mount's own, so nothing outlives the composer.
  const [localDraftAtom] = useState(() =>
    atom<ChatComposerDraft>(EMPTY_CHAT_DRAFT)
  );
  const [storedDraft, setStoredDraft] = useAtom(
    agentId ? chatDraftAtomFamily(agentId) : localDraftAtom
  );
  const draft = readChatComposerDraft(storedDraft);
  // The atom holds the draft in full; the size cap applies to what the atom
  // writes to storage (`chatDraftAtomFamily`), not to what is typed.
  const updateDraft = useCallback(
    (patch: (current: ChatComposerDraft) => ChatComposerDraft) => {
      setStoredDraft((prev) => patch(readChatComposerDraft(prev)));
    },
    [setStoredDraft]
  );
  const { text, links } = draft;
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
  const [error, setError] = useState<ComposerError | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Slash menu: open while the field is exactly "/<partial>", closed by
  // Escape until the text changes again.
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const query = slashItems?.length ? slashQuery(text) : null;
  const slashOpen = query !== null && slashDismissed !== text;
  const slashMatches = useMemo(
    () => (slashOpen ? filterSlashItems(slashItems ?? [], query) : []),
    [slashOpen, slashItems, query]
  );
  const slashActive =
    slashMatches.length > 0 ? slashIndex % slashMatches.length : 0;
  const pickSlash = useCallback(
    (item: SlashItem) => {
      if (item.command && onSlashCommand?.(item.name)) {
        setText("");
      } else {
        setText(`/${item.name} `);
      }
      setSlashIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [onSlashCommand, setText]
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();

  // ---- files: the draft has the descriptors, this ref has the bytes --------
  // Live `File` objects by `draftFileKey`. A pasted-text entry's file is
  // rebuilt from the text in the draft on demand, so it is always live.
  const filesRef = useRef<Map<string, File>>(new Map());
  // Per-file bookkeeping, same key: the media id once uploaded (so a retry
  // after a later failure does not upload it twice), image previews, and
  // the upload state.
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

  /** Remembers a file's bytes for its entry, with a thumbnail for images. */
  const holdFile = useCallback((key: string, file: File) => {
    filesRef.current.set(key, file);
    if (isImageAttachment(file) && !previewsRef.current.has(key)) {
      previewsRef.current.set(key, URL.createObjectURL(file));
    }
  }, []);

  /** Drops everything remembered about a file that is no longer attached. */
  const forgetFile = useCallback((key: string) => {
    filesRef.current.delete(key);
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
  }, []);

  /** The live file behind an entry, if this tab has (or can rebuild) one. */
  const fileFor = useCallback((entry: ChatDraftFile): File | undefined => {
    const key = draftFileKey(entry);
    const held = filesRef.current.get(key);
    if (held) return held;
    if (typeof entry.pasted !== "string") return undefined;
    const file = pastedTextFile(entry.pasted, entry.name);
    filesRef.current.set(key, file);
    return file;
  }, []);

  const fileViews = useMemo<DraftFileView[]>(
    () =>
      draft.files.map((entry) => ({
        entry,
        key: draftFileKey(entry),
        file: fileFor(entry),
      })),
    [draft.files, fileFor]
  );
  const placeholders = fileViews.filter((view) => view.file === undefined);

  // Bytes for entries the draft no longer lists (removed here, sent, or
  // taken out by another tab) are let go. Reads the draft, never writes it.
  useEffect(() => {
    const listed = new Set(draft.files.map(draftFileKey));
    for (const key of [...filesRef.current.keys()]) {
      if (!listed.has(key)) forgetFile(key);
    }
  }, [draft.files, forgetFile]);

  const attachmentCount = draft.files.length + links.length;
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
      if (accepted.length === 0) return;
      // One write. A file that re-attaches a placeholder fills that slot —
      // no new entry, no room needed; a file already attached is skipped; the
      // rest append while there is room under the cap.
      let overflowed = false;
      const held: Array<[string, File]> = [];
      updateDraft((current) => {
        const files = [...current.files];
        let room = CHAT_ATTACHMENTS_MAX - files.length - current.links.length;
        for (const file of accepted) {
          const entry = describeFile(file);
          const key = draftFileKey(entry);
          if (filesRef.current.has(key)) continue;
          const slot = files.findIndex(
            (candidate) =>
              typeof candidate.pasted !== "string" &&
              !filesRef.current.has(draftFileKey(candidate)) &&
              describesFile(candidate, file)
          );
          if (slot !== -1) {
            files[slot] = entry;
            held.push([key, file]);
            continue;
          }
          if (room <= 0) {
            overflowed = true;
            continue;
          }
          room -= 1;
          files.push(entry);
          held.push([key, file]);
        }
        return held.length === 0 ? current : { ...current, files };
      });
      for (const [key, file] of held) holdFile(key, file);
      if (overflowed) noteAttachmentLimit();
    },
    [holdFile, noteAttachmentLimit, updateDraft]
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

  const removeEntry = useCallback(
    (key: string) => {
      updateDraft((current) => {
        const files = current.files.filter(
          (entry) => draftFileKey(entry) !== key
        );
        return files.length === current.files.length
          ? current
          : { ...current, files };
      });
      forgetFile(key);
    },
    [forgetFile, updateDraft]
  );

  const addPastedText = useCallback(
    (pasted: string) => {
      if (attachmentsFull) {
        noteAttachmentLimit();
        return false;
      }
      const file = pastedTextFile(
        pasted,
        nextPastedFileName(draft.files.map((entry) => entry.name))
      );
      const entry = describeFile(file, pasted);
      filesRef.current.set(draftFileKey(entry), file);
      setError(null);
      updateDraft((current) => ({
        ...current,
        files: [...current.files, entry],
      }));
      return true;
    },
    [attachmentsFull, draft.files, noteAttachmentLimit, updateDraft]
  );

  /** Undo for a long paste: drop the chip, put the text back in the field. */
  const keepInline = useCallback(
    (view: DraftFileView) => {
      const pasted = view.entry.pasted ?? "";
      const el = textareaRef.current;
      updateDraft((current) => {
        const start = el?.selectionStart ?? current.text.length;
        const end = el?.selectionEnd ?? current.text.length;
        return {
          ...current,
          text: current.text.slice(0, start) + pasted + current.text.slice(end),
          files: current.files.filter(
            (entry) => draftFileKey(entry) !== view.key
          ),
        };
      });
      forgetFile(view.key);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [forgetFile, updateDraft]
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

  // The host's drop zone: native listeners on an element the composer does
  // not render, feeding the same addFiles as a drop on the field itself.
  useEffect(() => {
    const el = dropTargetRef?.current;
    if (!el) return;
    const hasFiles = (event: globalThis.DragEvent) =>
      !!event.dataTransfer?.types.includes("Files");
    const over = (event: globalThis.DragEvent) => {
      if (disabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onDropZoneDragging?.(true);
    };
    const leave = (event: globalThis.DragEvent) => {
      if (el.contains(event.relatedTarget as Node | null)) return;
      onDropZoneDragging?.(false);
    };
    const drop = (event: globalThis.DragEvent) => {
      onDropZoneDragging?.(false);
      if (disabled) return;
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      if (dropped.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles(dropped);
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, [addFiles, disabled, dropTargetRef, onDropZoneDragging]);

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
    const submittedFiles = fileViews;
    const submittedLinks = links;

    const run = async () => {
      const attachments: ChatUserAttachmentInput[] = [];
      for (const { entry, key, file } of submittedFiles) {
        // `canSend` ruled out placeholders; this is the same check for the
        // type system's sake.
        if (!file) throw new Error(`Re-attach ${entry.name} to send.`);
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
      await onSend(submittedText.trim(), attachments);
    };

    run()
      .then(() => {
        // What was sent leaves the draft in one write — text, links and
        // file entries together — so no render, remount or other tab ever
        // sees a draft that still lists a sent file.
        const sentKeys = new Set(submittedFiles.map((view) => view.key));
        updateDraft((current) => ({
          ...current,
          text: current.text === submittedText ? "" : current.text,
          links: current.links.filter((url) => !submittedLinks.includes(url)),
          files: current.files.filter(
            (entry) => !sentKeys.has(draftFileKey(entry))
          ),
        }));
        for (const key of sentKeys) forgetFile(key);
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
    canSend,
    fileViews,
    forgetFile,
    links,
    onSend,
    text,
    updateDraft,
    uploadFile,
  ]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashMatches.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashIndex(
            (i) => (i - 1 + slashMatches.length) % slashMatches.length
          );
          return;
        }
        if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          pickSlash(slashMatches[slashActive]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashDismissed(text);
          return;
        }
      }
      if (event.key !== "Enter") return;
      if (event.shiftKey) return;
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [pickSlash, slashActive, slashMatches, submit, text]
  );

  const uploadingName = fileViews.find(
    (view) => fileStatus[view.key] === "uploading"
  )?.entry.name;
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
          "relative rounded-lg border bg-card/70 transition-colors",
          disabled
            ? "border-border opacity-70"
            : draggingFiles
              ? "border-status-done bg-status-done/10 ring-1 ring-inset ring-status-done/30"
              : "border-border focus-within:border-foreground/30 hover:border-foreground/20"
        )}
      >
        {slashMatches.length > 0 ? (
          <div
            role="listbox"
            aria-label="Slash commands"
            data-testid="chat-composer-slash-menu"
            className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-md overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            {slashMatches.map((item, i) => (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={i === slashActive}
                data-testid="chat-composer-slash-item"
                onMouseDown={(event) => {
                  // Keep the field's focus; a click picks like Enter does.
                  event.preventDefault();
                  pickSlash(item);
                }}
                onMouseEnter={() => setSlashIndex(i)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs",
                  i === slashActive ? "bg-accent text-accent-foreground" : ""
                )}
              >
                <span className="shrink-0 font-terminal">/{item.name}</span>
                {item.description ? (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
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
            {fileViews.map((view) =>
              view.file === undefined ? (
                <DraftPlaceholderChip
                  key={view.key}
                  entry={view.entry}
                  onRemove={() => removeEntry(view.key)}
                />
              ) : typeof view.entry.pasted === "string" ? (
                <PastedTextChip
                  key={view.key}
                  file={view.file}
                  lines={countLines(view.entry.pasted)}
                  status={fileStatus[view.key]}
                  onKeepInline={() => keepInline(view)}
                  onRemove={() => removeEntry(view.key)}
                />
              ) : (
                <ContextFileItem
                  key={view.key}
                  file={view.file}
                  preview={previewsRef.current.get(view.key)}
                  status={fileStatus[view.key]}
                  onRemove={() => removeEntry(view.key)}
                />
              )
            )}
            {links.map((link) => (
              <ContextLinkItem
                key={link}
                link={link}
                onRemove={() => removeLink(link)}
              />
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
        ) : placeholders.length > 0 ? (
          <span data-testid="chat-composer-reattach-hint">
            {placeholders.length === 1
              ? `Re-attach or remove ${placeholders[0]!.entry.name} to send.`
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
