import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CHAT_ATTACHMENTS_MAX, CHAT_MESSAGE_MAX_CHARS } from "@dispatch/shared";
import { atom, useAtom } from "jotai";
import {
  AtSign,
  ChevronDown,
  CornerDownRight,
  ListPlus,
  Plus,
  SquareSlash,
  SendHorizontal,
  X,
} from "lucide-react";

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
import { MentionPicker } from "@/components/app/chat/mention-picker";
import { SlashPicker } from "@/components/app/chat/slash-picker";
import {
  matchSlashCommands,
  slashQueryAt,
  type SlashCommand,
} from "@/components/app/chat/slash-commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  insertMention,
  matchMentionables,
  mentionSpans,
  type Mentionable,
  mentionQueryAt,
} from "@/lib/mentions";
import {
  type ChatComposerDraft,
  type ChatDraftFile,
  EMPTY_CHAT_DRAFT,
  readChatComposerDraft,
} from "@/lib/chat-draft";
import { ApiError } from "@/lib/api";
import { isImageFile } from "@/lib/file-accept";
import { isAcceptedUploadFile } from "@/lib/file-upload";
import { chatDraftAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

export type ChatComposerProps = {
  /**
   * Keys the persisted draft. With no agent the draft lives in memory only
   * and is dropped on unmount.
   */
  agentId: string | null;
  /**
   * A control beside Send: Stop while the agent's turn runs. The composer
   * is the one spot that never moves and has room on a phone.
   */
  action?: ReactNode;
  /**
   * Resolves once the message is accepted; rejects when it is not. The draft
   * — text and attachments — is cleared only on success so a failed send
   * never eats what was typed.
   */
  onSend: (
    text: string,
    attachments: ChatUserAttachmentInput[],
    options?: { interrupt?: boolean }
  ) => Promise<void>;
  /**
   * A turn is running, so a plain send would queue behind it. Offers "Send
   * now", which cuts the turn and makes this message what the agent reads
   * next.
   */
  canInterrupt?: boolean;
  /**
   * Uploads one attached file and resolves to its file id. Called at send
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
   * composer stays mounted under another tab, so coming back to the Agent tab
   * arrives as a prop change, not a mount.
   */
  autoFocus?: boolean;
  /**
   * When set, what gets typed answers this question rather than starting a
   * plain message. The × lets the user opt out and send a plain message.
   */
  replyContext?: { excerpt: string; onDismiss: () => void } | null;
  /** The agents a typed `@` can name: the stream's tree. */
  mentionables?: readonly Mentionable[];
  /** Agent-advertised commands and local Dispatch actions in the slash menu. */
  slashCommands?: readonly SlashCommand[];
  /** Return true when a Dispatch command was handled without sending a turn. */
  onDispatchCommand?: (name: string) => boolean;
};

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
 * bookkeeping: live files, previews, file ids, upload state.
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

/**
 * An upload the server refused (a 4xx): the same bytes would be refused
 * again, so the way on is to remove the file, not to retry.
 */
class UploadRefused extends Error {}

const SUPPORTED_FILE_HINT =
  "Choose a supported file type: an image, video, PDF, or text file.";

/**
 * Enter sends, Shift+Enter inserts a newline. An in-progress IME composition
 * is left alone: the Enter that commits a CJK candidate must not send.
 *
 * Attachments ride along as chips above the field: files from the
 * attachment button, a drop or a paste; links from a pasted URL. Files upload when
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
  action,
  mentionables,
  slashCommands,
  onDispatchCommand,
  canInterrupt = false,
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
  const caretFrameRef = useRef<number | null>(null);
  const cancelCaretFocus = useCallback(() => {
    if (caretFrameRef.current !== null)
      cancelAnimationFrame(caretFrameRef.current);
    caretFrameRef.current = null;
  }, []);
  useEffect(() => cancelCaretFocus, [cancelCaretFocus]);

  // ---- @mentions: the token under the caret opens the picker ---------------
  const [caret, setCaret] = useState(0);
  // Escape closes the list until the text changes again.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(
    null
  );
  const slashListId = useId();
  const hasSlashAttachments = draft.files.length > 0 || links.length > 0;
  const hasSlashMention =
    !!mentionables?.length &&
    mentionSpans(text, mentionables).some((span) => span.kind === "mention");
  const advertisedName = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
  const advertisedCommand = slashCommands?.some(
    (command) => command.source === "agent" && command.name === advertisedName
  );
  const slashBlockedReason = advertisedCommand
    ? replyContext
      ? "Agent commands must start a new post. Dismiss the reply first."
      : hasSlashAttachments
        ? "Remove attachments to run this agent command."
        : hasSlashMention
          ? "Remove agent mentions to run this agent command."
          : null
    : null;
  const slashUnavailableReason =
    disabledReason ??
    (replyContext
      ? "Dismiss the reply to use commands."
      : hasSlashAttachments
        ? "Remove attachments to use commands."
        : hasSlashMention
          ? "Remove agent mentions to use commands."
          : !slashCommands?.length
            ? "No commands are available for this agent."
            : null);
  const slashQuery =
    !slashUnavailableReason && slashDismissedFor !== text
      ? slashQueryAt(text, caret)
      : null;
  const slashCandidates = useMemo(
    () =>
      slashQuery !== null && slashCommands
        ? matchSlashCommands(slashQuery, slashCommands)
        : [],
    [slashQuery, slashCommands]
  );
  const slashOpen = slashCandidates.length > 0;
  const activeSlash = Math.min(slashIndex, slashCandidates.length - 1);
  const mentionQuery =
    !slashOpen &&
    mentionables &&
    mentionables.length > 0 &&
    dismissedFor !== text
      ? mentionQueryAt(text, caret)
      : null;
  const mentionCandidates = useMemo(
    () =>
      mentionQuery && mentionables
        ? matchMentionables(mentionQuery.query, mentionables).slice(0, 8)
        : [],
    [mentionQuery, mentionables]
  );
  const mentionOpen = mentionCandidates.length > 0;
  const activeMention = Math.min(mentionIndex, mentionCandidates.length - 1);
  const pickMention = useCallback(
    (agent: Mentionable) => {
      if (!mentionQuery) return;
      const next = insertMention(text, mentionQuery.start, caret, agent);
      setText(next.text);
      setCaret(next.caret);
      setMentionIndex(0);
      // The name just placed still matches itself; the list stays closed
      // until the text moves on.
      setDismissedFor(next.text);
      const el = textareaRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          el.setSelectionRange(next.caret, next.caret);
        });
      }
    },
    [caret, mentionQuery, setText, text]
  );
  const pickSlash = useCallback(
    (command: SlashCommand) => {
      let nextCaret = 0;
      if (command.source === "dispatch" && onDispatchCommand?.(command.name)) {
        // A toolbar command can precede an existing draft. Consuming the
        // command locally must not consume that draft as well.
        const remaining = text.slice(caret).replace(/^\s*/, "");
        setText(remaining);
        setCaret(0);
        setSlashDismissedFor(remaining);
      } else {
        const next = `/${command.name} ${text.slice(caret).replace(/^\s*/, "")}`;
        nextCaret = command.name.length + 2;
        setText(next);
        setCaret(nextCaret);
        setSlashDismissedFor(next);
      }
      setSlashIndex(0);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        el?.focus();
        el?.setSelectionRange(nextCaret, nextCaret);
      });
    },
    [caret, onDispatchCommand, setText, text]
  );
  const focusCaret = (position: number) => {
    cancelCaretFocus();
    setCaret(position);
    caretFrameRef.current = requestAnimationFrame(() => {
      caretFrameRef.current = null;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
    });
  };

  const openMentions = () => {
    const input = textareaRef.current;
    if (!input || disabledReason || !mentionables?.length) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    // Reopen a query already under the caret rather than inserting another @.
    const existing = start === end ? mentionQueryAt(text, start) : null;
    if (
      existing &&
      !/\s$/.test(existing.query) &&
      matchMentionables(existing.query, mentionables).length > 0
    ) {
      setDismissedFor(null);
      setSlashDismissedFor(text);
      setMentionIndex(0);
      focusCaret(start);
      return;
    }
    const prefix = text.slice(0, start);
    const trigger =
      start === 0 || /[\s([{"']/.test(text[start - 1]!) ? "@" : " @";
    const next = prefix + trigger + text.slice(end);
    if (next.length > CHAT_MESSAGE_MAX_CHARS) return;
    setText(next);
    setDismissedFor(null);
    setSlashDismissedFor(next);
    setMentionIndex(0);
    focusCaret(start + trigger.length);
  };

  const openCommands = () => {
    if (slashUnavailableReason) return;
    // Keep the draft after a separating space so the cursor can type a
    // command query at the start, using the same picker as a typed slash.
    const prefix = /^\/[^\s/]*(?=\s|$)/.exec(text);
    const next = prefix ? text : "/" + (text ? " " + text : "");
    if (next.length > CHAT_MESSAGE_MAX_CHARS) return;
    setText(next);
    setSlashDismissedFor(null);
    setSlashIndex(0);
    setDismissedFor(next);
    focusCaret(prefix ? prefix[0].length : 1);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = disabledReason !== null;
  const trimmed = text.trim();

  // ---- files: the draft has the descriptors, this ref has the bytes --------
  // Live `File` objects by `draftFileKey`. A pasted-text entry's file is
  // rebuilt from the text in the draft on demand, so it is always live.
  const filesRef = useRef<Map<string, File>>(new Map());
  // Per-file bookkeeping, same key: the file id once uploaded (so a retry
  // after a later failure does not upload it twice), image previews, and
  // the upload state.
  const fileIdsRef = useRef<Map<string, number>>(new Map());
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
    fileIdsRef.current.delete(key);
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

  const canSend =
    !disabled &&
    !slashBlockedReason &&
    !sending &&
    !inFlight &&
    placeholders.length === 0 &&
    (trimmed.length > 0 || attachmentCount > 0);

  // The text owns its rectangle; the toolbar never overlaps its last line.
  useLayoutEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = String(input.scrollHeight) + "px";
    };
    resize();
    let width = input.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (input.clientWidth === width) return;
            width = input.clientWidth;
            resize();
          });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const submit = useCallback(
    (options?: { interrupt?: boolean }) => {
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
          let fileId = fileIdsRef.current.get(key);
          if (fileId === undefined) {
            if (!uploadFile) throw new Error("File uploads are not available.");
            setFileStatus((current) => ({ ...current, [key]: "uploading" }));
            try {
              const uploaded = await uploadFile(file);
              fileId = uploaded.id;
              fileIdsRef.current.set(key, fileId);
              setFileStatus((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
            } catch (err) {
              setFileStatus((current) => ({ ...current, [key]: "failed" }));
              const reason = err instanceof Error ? err.message : "";
              if (
                err instanceof ApiError &&
                err.status >= 400 &&
                err.status < 500
              ) {
                throw new UploadRefused(
                  `${reason || `Couldn't upload ${file.name}.`} Remove ${file.name} to send the rest.`
                );
              }
              throw new Error(
                `Couldn't upload ${file.name}${reason ? `: ${reason}` : ""}`
              );
            }
          }
          attachments.push({ type: "file", fileId });
        }
        for (const url of submittedLinks)
          attachments.push({ type: "link", url });
        await (options
          ? onSend(submittedText.trim(), attachments, options)
          : onSend(submittedText.trim(), attachments));
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
          // The draft — text and chips — is still here, so a retry can work,
          // unless the server refused a file, which a retry would send again.
          setError({
            text: err instanceof Error ? err.message : "Message not sent.",
            retryable: !(err instanceof UploadRefused),
          });
        })
        .finally(() => {
          setInFlight(false);
          textareaRef.current?.focus();
        });
    },
    [
      canSend,
      fileViews,
      forgetFile,
      links,
      onSend,
      text,
      updateDraft,
      uploadFile,
    ]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        submit(canInterrupt ? { interrupt: true } : undefined);
        return;
      }
      if (slashOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const n = slashCandidates.length;
          setSlashIndex(
            (i) => (i + (event.key === "ArrowDown" ? 1 : n - 1)) % n
          );
          return;
        }
        if (
          (event.key === "Enter" || event.key === "Tab") &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          pickSlash(slashCandidates[activeSlash]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashDismissedFor(text);
          return;
        }
      }
      if (mentionOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const n = mentionCandidates.length;
          setMentionIndex(
            (i) => (i + (event.key === "ArrowDown" ? 1 : n - 1)) % n
          );
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          pickMention(mentionCandidates[activeMention]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDismissedFor(text);
          return;
        }
      }
      if (event.key !== "Enter") return;
      if (event.shiftKey) return;
      event.preventDefault();
      submit();
    },
    [
      activeMention,
      activeSlash,
      canInterrupt,
      mentionCandidates,
      mentionOpen,
      pickMention,
      pickSlash,
      slashCandidates,
      slashOpen,
      submit,
      text,
    ]
  );
  const syncCaret = useCallback(
    (event: { currentTarget: HTMLTextAreaElement }) => {
      setCaret(event.currentTarget.selectionStart ?? 0);
    },
    []
  );

  const uploadingName = fileViews.find(
    (view) => fileStatus[view.key] === "uploading"
  )?.entry.name;
  const hasAttachments = attachmentCount > 0;
  const sendNowShortcut =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform)
      ? "⌘⇧Enter"
      : "Ctrl+Shift+Enter";

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
          "rounded-2xl border bg-card/70 transition-colors",
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
        <div className="relative">
          {mentionOpen ? (
            <MentionPicker
              candidates={mentionCandidates}
              activeIndex={activeMention}
              onPick={pickMention}
              onHover={setMentionIndex}
              anchor={textareaRef.current}
            />
          ) : null}
          {slashOpen ? (
            <SlashPicker
              candidates={slashCandidates}
              activeIndex={activeSlash}
              listId={slashListId}
              onPick={pickSlash}
              onHover={setSlashIndex}
              anchor={textareaRef.current}
            />
          ) : null}
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => {
              cancelCaretFocus();
              if (event.target.value !== text) setSlashDismissedFor(null);
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? 0);
              setMentionIndex(0);
              setSlashIndex(0);
            }}
            onSelect={syncCaret}
            onClick={syncCaret}
            onKeyUp={syncCaret}
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
            role={slashOpen ? "combobox" : undefined}
            aria-autocomplete={slashOpen ? "list" : undefined}
            aria-haspopup={slashOpen ? "listbox" : undefined}
            aria-expanded={slashOpen ? true : undefined}
            aria-controls={slashOpen ? slashListId : undefined}
            aria-activedescendant={
              slashOpen ? `${slashListId}-option-${activeSlash}` : undefined
            }
            // The box around it is the border; the field itself is bare.
            className="max-h-48 min-h-14 w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 pb-2 pt-4 text-sm shadow-none backdrop-blur-none focus-visible:ring-0 pointer-coarse:text-base"
            data-testid="chat-composer-input"
          />

          <div
            className="flex items-center justify-between gap-2 px-2 pb-2 pointer-coarse:gap-0 pointer-coarse:px-1"
            data-testid="chat-composer-controls"
          >
            <div className="flex shrink-0 items-center gap-0.5 pointer-coarse:gap-0">
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
                className="h-9 w-9 shrink-0 rounded-full bg-muted/60 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <Plus className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={disabled || !mentionables?.length}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openMentions}
                title={
                  mentionables?.length
                    ? "Mention an agent (@)"
                    : "No agents available to mention"
                }
                aria-label="Mention an agent"
                aria-haspopup="listbox"
                aria-expanded={mentionOpen}
                data-testid="chat-composer-mention-button"
                className="h-9 w-9 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <AtSign className="h-[18px] w-[18px]" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={Boolean(slashUnavailableReason)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openCommands}
                title={slashUnavailableReason ?? "Slash commands (/)"}
                aria-label="Slash commands"
                aria-haspopup="listbox"
                aria-expanded={slashOpen}
                aria-controls={slashOpen ? slashListId : undefined}
                data-testid="chat-composer-command-button"
                className="h-9 w-9 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              >
                <SquareSlash className="h-[18px] w-[18px]" />
              </Button>
            </div>

            <div className="flex items-center gap-1 pointer-coarse:gap-0">
              {action ? (
                <>
                  {action}
                  <span
                    className="mx-1 h-5 w-px bg-border pointer-coarse:mx-0.5"
                    aria-hidden="true"
                  />
                </>
              ) : null}
              <div
                className="inline-flex items-center"
                role="group"
                aria-label="Send message actions"
              >
                <Button
                  type="submit"
                  size="icon"
                  variant={canSend ? "success" : "ghost"}
                  disabled={!canSend}
                  title={
                    canInterrupt
                      ? "Queue message until the turn ends (Enter)"
                      : "Send (Enter)"
                  }
                  aria-label={canInterrupt ? "Queue message" : "Send message"}
                  data-testid="chat-composer-send"
                  className={cn(
                    "h-9 w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
                    canInterrupt && "rounded-r-none"
                  )}
                >
                  {canInterrupt ? (
                    <ListPlus className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <SendHorizontal className="h-4 w-4" aria-hidden="true" />
                  )}
                </Button>
                {canInterrupt ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant={canSend ? "success" : "ghost"}
                        disabled={!canSend}
                        aria-label="Send options"
                        title="Send options"
                        data-testid="chat-composer-send-options"
                        className="h-9 w-7 rounded-l-none border-l border-l-background/20 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      side="top"
                      align="end"
                      className="w-72"
                    >
                      <DropdownMenuItem
                        disabled={!canSend}
                        onSelect={() => submit()}
                        className="text-foreground"
                      >
                        <span className="flex justify-between gap-3">
                          Queue message{" "}
                          <span className="text-muted-foreground">Enter</span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Send when the current turn ends
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canSend}
                        onSelect={() => submit({ interrupt: true })}
                        data-testid="chat-composer-send-now"
                        className="text-foreground"
                      >
                        <span className="flex justify-between gap-3">
                          Send now{" "}
                          <span className="text-muted-foreground">
                            {sendNowShortcut}
                          </span>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Stop the current turn and send this message
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="px-1 text-[10px] text-muted-foreground">
        {disabledReason ? (
          <span data-testid="chat-composer-disabled-reason">
            {disabledReason}
          </span>
        ) : slashBlockedReason ? (
          <span role="alert" data-testid="chat-composer-slash-hint">
            {slashBlockedReason}
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
            {canInterrupt ? "Enter to queue" : "Enter to send"} · Shift+Enter
            for a new line
            {canInterrupt
              ? ` · ${sendNowShortcut} to send now`
              : " · paste or drop files"}
          </span>
        )}
      </div>
    </form>
  );
}
