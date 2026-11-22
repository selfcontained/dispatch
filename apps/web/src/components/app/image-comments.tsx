import { useEffect, useRef, useState } from "react";
import { BLOCK_TEXT_MAX_CHARS } from "@dispatch/shared";
import { atom, useAtom, useStore } from "jotai";
import { atomFamily } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Hand,
  MessageCircle,
  Minus,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { agentListQuery } from "@/hooks/use-agents";
import { streamFeedFilters, threadQueryKey } from "@/hooks/use-stream";
import { imageFeedbackMessage } from "@/lib/image-feedback-message";
import {
  type ImageCalloutRegion,
  imageFeedbackCaptions,
  imageFeedbackMetadata,
  imageFeedbackNotes,
  renderAnnotatedImage,
  imageRasterSize,
} from "@/lib/image-feedback";
import { createClientId } from "@/lib/client-id";
import { api, ApiError } from "@/lib/api";
import { atomWithLocalStorage } from "@/lib/store";
import type { FileItem } from "./types";
import { seatClasses } from "@/lib/agent-seat";
import { agentTurnLocation } from "@/lib/agent-routes";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { FileActions } from "./file-lightbox-actions";

export type ImageShareLocation = {
  streamId: string;
  threadId: string | null;
  blockId: string;
};
type Callout = {
  id: string;
  number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
  recipient: string;
  sent: boolean;
  copyId?: number;
  metadataId?: number;
  delivered?: boolean | null;
  attempted?: boolean;
  location?: ImageShareLocation;
};
const markupHintDismissedAtom = atomWithLocalStorage(
  "dispatch:markup-hint-dismissed",
  false,
  { validate: (value): value is boolean => typeof value === "boolean" }
);

const commentsFamily = atomFamily((key: string) =>
  atomWithLocalStorage<Callout[]>(`dispatch:image-comments:${key}`, [], {
    validate: (value): value is Callout[] =>
      Array.isArray(value) &&
      value.every(
        (c) =>
          c &&
          typeof c.id === "string" &&
          Number.isInteger(c.number) &&
          c.number > 0 &&
          typeof c.note === "string" &&
          typeof c.recipient === "string" &&
          typeof c.sent === "boolean" &&
          [c.x, c.y, c.width, c.height].every(
            (n) =>
              typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1
          )
      ),
  })
);

type ShareAttempt = {
  id: string;
  recipient: string;
  items: Callout[];
  copyId?: number;
  metadataId?: number;
  attempted?: boolean;
};
const validShare = (value: unknown): value is ShareAttempt | null => {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const batch = value as ShareAttempt;
  return (
    typeof batch.id === "string" &&
    typeof batch.recipient === "string" &&
    Array.isArray(batch.items) &&
    batch.items.length > 0 &&
    batch.items.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.note === "string" &&
        Number.isInteger(c.number) &&
        [c.x, c.y, c.width, c.height].every(
          (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1
        )
    )
  );
};
const sharesFamily = atomFamily((key: string) =>
  atomWithLocalStorage<ShareAttempt | null>(
    `dispatch:image-comment-share:${key}`,
    null,
    { validate: validShare }
  )
);
// A per-message recovery record cannot be erased by another tab editing drafts.
const postedFamily = atomFamily((key: string) =>
  atomWithLocalStorage<ShareAttempt | null>(
    `dispatch:image-comment-post:${key}`,
    null,
    { validate: validShare }
  )
);
function storedPost(imageKey: string): ShareAttempt | null {
  try {
    const prefix = `dispatch:image-comment-post:${imageKey}:`;
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const value: unknown = JSON.parse(
        window.localStorage.getItem(key) ?? "null"
      );
      if (validShare(value) && value?.attempted) return value;
    }
  } catch {
    /* Storage unavailable: the mounted tab still retains its attempt. */
  }
  return null;
}

/**
 * Marks up an image that is not uploaded yet (a composer attachment): the
 * callouts stay with the caller, and "Done" hands them back without sending.
 */
export type ImageComposeMarkup = {
  fileName: string;
  callouts: readonly ImageCalloutRegion[];
  onDone: (callouts: ImageCalloutRegion[]) => void;
};

const toCallout = (c: ImageCalloutRegion): Callout => ({
  id: c.id,
  number: c.number,
  x: c.x,
  y: c.y,
  width: c.width,
  height: c.height,
  note: c.note,
  recipient: "",
  sent: false,
});

/** Image callouts use normalized, oriented image coordinates; sent notes are also in the stream. */
export function ImageComments({
  file,
  compose,
  src,
  caption,
  positionLabel,
  onClose,
  onPrevious,
  onNext,
  onShared,
}: (
  | { file: FileItem; compose?: undefined }
  | { file?: undefined; compose: ImageComposeMarkup }
) & {
  src: string;
  caption: string;
  positionLabel: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onShared?: (location: ImageShareLocation) => void;
}): JSX.Element {
  const store = useStore();
  const fileName = file?.name ?? compose?.fileName ?? "";
  const imageKey = file ? `${file.url}:${file.updatedAt}` : "";
  const postedRef = useRef<ShareAttempt | null>(null);
  const pendingPost = file ? (storedPost(imageKey) ?? postedRef.current) : null;
  // Compose mode keeps its working copy in memory only: no share batches,
  // no recipients, nothing in localStorage.
  const [composeAtoms] = useState(() => ({
    comments: atom<Callout[]>((compose?.callouts ?? []).map(toCallout)),
    share: atom<ShareAttempt | null>(null),
  }));
  const clearPosted = (batch: ShareAttempt) => {
    const record = postedFamily(`${imageKey}:${batch.id}`);
    // This atom may be new to this tab's store after reload. Prime it before
    // clearing so the persistence helper cannot treat null as an unchanged value.
    store.set(record, { ...batch, attempted: true });
    store.set(record, null);
    postedRef.current = null;
  };
  const [comments, setComments] = useAtom(
    file ? commentsFamily(imageKey) : composeAtoms.comments
  );
  const [shareAttempt, setShareAttempt] = useAtom(
    file ? sharesFamily(imageKey) : composeAtoms.share
  );
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const notePopover = useRef<HTMLDivElement>(null);
  const markupButton = useRef<HTMLButtonElement>(null);
  const [markup, setMarkup] = useState(!!compose);
  const [hintDismissed, setHintDismissed] = useAtom(markupHintDismissedAtom);
  const [editorNote, setEditorNote] = useState("");
  const newComment = useRef<string | null>(null);
  const [mode, setMode] = useState<"comment" | "pan">(
    compose ? "comment" : "pan"
  );
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const world = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{
    distance: number;
    zoom: number;
    anchor: { x: number; y: number };
  } | null>(null);
  const pinchPoints = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b || !stageElement) return null;
    const rect = stageElement.getBoundingClientRect();
    return {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      x: ((a.x + b.x) / 2 - rect.left - (stageSize.width - rw) / 2) / ratio,
      y: ((a.y + b.y) / 2 - rect.top - (stageSize.height - rh) / 2) / ratio,
    };
  };
  const gesture = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    pan: typeof pan;
  } | null>(null);
  // A press that starts on the backdrop around the image. It closes the viewer
  // only if it also ends there, so a pan or drag released outside never does.
  const backdropPress = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    editing: boolean;
  } | null>(null);
  const backdropClose = useRef(false);
  const [preview, setPreview] = useState<Callout | null>(null);
  const { data: agents = [] } = useQuery({
    ...agentListQuery,
    enabled:
      !compose &&
      (selected !== null ||
        comments.some((c) => !c.sent && !!c.note.trim()) ||
        !!shareAttempt),
  });
  const pathAgent = window.location.pathname.match(/\/agents\/([^/]+)/)?.[1];
  const defaultRecipient = compose
    ? ""
    : (pathAgent ?? file?.ownerAgentId ?? "");
  const [recipient, setRecipient] = useState(defaultRecipient);
  const shareRecipient =
    pendingPost?.recipient ?? shareAttempt?.recipient ?? recipient;
  const current = comments.find((c) => c.id === selected);
  const queryClient = useQueryClient();
  useEffect(() => {
    const el = stageElement;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setStageSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageElement]);
  const ratio = Math.min(
    stageSize.width / imageSize.width,
    stageSize.height / imageSize.height
  );
  const rw = imageSize.width * ratio;
  const rh = imageSize.height * ratio;
  const point = (event: React.PointerEvent<SVGSVGElement>) => {
    const p = svg.current!.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    const q = p.matrixTransform(world.current!.getScreenCTM()!.inverse());
    return { x: q.x / imageSize.width, y: q.y / imageSize.height };
  };
  const onBackdrop = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      return false;
    if (!loaded) return true;
    const p = point(event);
    return p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1;
  };
  const update = (id: string, patch: Partial<Callout>) => {
    if (pendingPost || shareAttempt?.attempted || send.isPending) return;
    setShareAttempt(null);
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };
  const dismissEditor = () => {
    const id = newComment.current;
    if (id) setComments((cs) => cs.filter((c) => c.id !== id));
    newComment.current = null;
    setSelected(null);
  };
  const leaveMarkup = () => {
    if (send.isPending) return;
    dismissEditor();
    if (compose) {
      onClose();
      return;
    }
    setMarkup(false);
    setMode("pan");
    requestAnimationFrame(() => markupButton.current?.focus());
    setPreview(null);
    gesture.current = null;
  };
  const create = (region: Pick<Callout, "x" | "y" | "width" | "height">) => {
    if (pendingPost || shareAttempt?.attempted || send.isPending) return;
    setShareAttempt(null);
    const c: Callout = {
      ...region,
      id: createClientId(),
      number: Math.max(0, ...comments.map((c) => c.number)) + 1,
      note: "",
      sent: false,
      recipient: defaultRecipient,
    };
    const previous = newComment.current;
    setComments((cs) => [...cs.filter((n) => n.id !== previous), c]);
    newComment.current = c.id;
    setEditorNote("");
    setSelected(c.id);
  };
  const send = useMutation({
    mutationFn: async (batch: ShareAttempt) => {
      if (!image.current || !loaded || !batch.recipient || !batch.items.length)
        throw new Error("Add notes and choose an agent.");
      if (!file) throw new Error("Nothing to share.");
      const text = imageFeedbackMessage(
        imageFeedbackNotes(batch.items),
        file.name
      );
      if (text.length > BLOCK_TEXT_MAX_CHARS)
        throw new Error(
          "These notes are too long for one message. Shorten them before sharing."
        );
      const cache = (patch: Partial<ShareAttempt>) => {
        let ownsAttempt = false;
        setShareAttempt((old) => {
          if (old?.id !== batch.id) return old;
          ownsAttempt = true;
          return { ...old, ...patch };
        });
        if (!ownsAttempt)
          throw new Error(
            "This share changed in another tab before sending. Your notes are kept; share again."
          );
      };
      let copyId = batch.copyId;
      const scale = Math.min(
        1,
        2560 / Math.max(imageSize.width, imageSize.height)
      );
      if (!copyId) {
        const { blob } = await renderAnnotatedImage(
          image.current,
          imageSize,
          batch.items
        );
        const body = new FormData();
        body.append("file", blob, `feedback-${batch.id}.png`);
        const uploaded = await api<{ file: { id: number } }>(
          `/api/v1/agents/${encodeURIComponent(batch.recipient)}/files`,
          { method: "POST", body }
        );
        copyId = uploaded.file.id;
        cache({ copyId });
      }
      const metadata = imageFeedbackMetadata({
        shareId: batch.id,
        original: {
          fileId: file.id,
          name: file.name,
          url: file.url,
          updatedAt: file.updatedAt,
          width: imageSize.width,
          height: imageSize.height,
        },
        derivedFileId: copyId,
        derivedSize: {
          width: Math.round(imageSize.width * scale),
          height: Math.round(imageSize.height * scale),
        },
        items: batch.items,
      });
      let metadataId = batch.metadataId;
      if (!metadataId) {
        const body = new FormData();
        body.append(
          "file",
          new Blob([JSON.stringify(metadata, null, 2)], {
            type: "application/json",
          }),
          `feedback-${batch.id}.json`
        );
        const uploaded = await api<{ file: { id: number } }>(
          `/api/v1/agents/${encodeURIComponent(batch.recipient)}/files`,
          { method: "POST", body }
        );
        metadataId = uploaded.file.id;
        cache({ metadataId });
      }
      cache({ attempted: true });
      const submitted = { ...batch, copyId, metadataId, attempted: true };
      postedRef.current = submitted;
      store.set(postedFamily(`${imageKey}:${batch.id}`), submitted);
      let delivered: boolean | null = null;
      let location: ImageShareLocation = {
        streamId: batch.recipient,
        threadId: null,
        blockId: batch.id,
      };
      try {
        const result = await api<{
          delivered: boolean | null;
          block?: { id: string; streamId: string; threadId: string | null };
        }>(`/api/v1/streams/${encodeURIComponent(batch.recipient)}/blocks`, {
          method: "POST",
          body: JSON.stringify({
            id: batch.id,
            to: batch.recipient,
            text,
            attachments: [
              {
                type: "file",
                fileId: copyId,
                caption: imageFeedbackCaptions.copy(file.name),
              },
              {
                type: "file",
                fileId: metadataId,
                caption: imageFeedbackCaptions.metadata,
              },
            ],
          }),
        });
        delivered = result.delivered;
        if (result.block)
          location = {
            streamId: result.block.streamId,
            threadId: result.block.threadId,
            blockId: result.block.id,
          };
      } catch (error) {
        // These API responses reject before creating a block. Keep identity
        // for network/timeout/server ambiguity, but allow recovery from rejection.
        if (
          error instanceof ApiError &&
          [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status)
        ) {
          clearPosted(batch);
          setShareAttempt((old) => (old?.id === batch.id ? null : old));
        }
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        await api(
          `/api/v1/streams/${encodeURIComponent(batch.recipient)}/blocks/${batch.id}/metadata`
        );
      }
      return { ...batch, delivered, location };
    },
    onSuccess: (batch) => {
      clearPosted(batch);
      const originals = new Map(batch.items.map((c) => [c.id, c]));
      setComments((cs) =>
        cs.map((c) =>
          originals.get(c.id)?.note === c.note &&
          originals.get(c.id)?.x === c.x &&
          originals.get(c.id)?.y === c.y &&
          originals.get(c.id)?.width === c.width &&
          originals.get(c.id)?.height === c.height
            ? {
                ...c,
                sent: true,
                recipient: batch.recipient,
                delivered: batch.delivered,
                location: batch.location,
              }
            : c
        )
      );
      setShareAttempt((old) => (old?.id === batch.id ? null : old));
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      // Share bypasses the chat composer's cache reconciliation. A stored
      // receipt must refresh its destination even if its SSE event was missed.
      // Keep the server's feed projection (ordering and attachment dimensions).
      void queryClient.invalidateQueries(
        streamFeedFilters(batch.location.streamId)
      );
      if (batch.location.threadId)
        void queryClient.invalidateQueries({
          queryKey: threadQueryKey(
            batch.location.streamId,
            batch.location.threadId
          ),
          exact: true,
        });
      if (onShared) onShared(batch.location);
      else onClose();
    },
  });
  const busy = send.isPending;
  const frozen = busy || !!pendingPost || !!shareAttempt?.attempted;
  const unshared = comments.filter((c) => !c.sent && c.note.trim());
  const share = () => {
    if (busy || selectedRef.current) return;
    const batch = storedPost(imageKey) ??
      postedRef.current ??
      shareAttempt ?? {
        id: createClientId(),
        recipient: shareRecipient,
        items: unshared.map((c) => ({ ...c })),
      };
    setShareAttempt(batch);
    setSelected(null);
    send.mutate(batch);
  };
  const close = () => {
    if (!busy) {
      dismissEditor();
      onClose();
    }
  };
  // Compose mode keeps its notes only in the composer, so finishing hands
  // the saved ones back rather than discarding them.
  const finishCompose = () => {
    if (!compose) return;
    compose.onDone(
      comments
        .filter((c) => c.note.trim())
        .map((c) => ({
          id: c.id,
          number: c.number,
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          note: c.note.trim(),
        }))
    );
    onClose();
  };
  const closeFromBackdrop = () => {
    if (compose && loaded) finishCompose();
    else close();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-testid="file-lightbox"
        aria-label={caption}
        aria-describedby={undefined}
        className="inset-0 z-viewer-modal h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-background p-0"
        overlayClassName="z-viewer-modal"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (selected) dismissEditor();
          else if (markup) leaveMarkup();
          else close();
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{caption}</DialogTitle>
        {/* The viewer covers the whole screen, including iPad's status bar
            and home indicator bands (viewport-fit=cover), so its bars pad
            themselves by the insets and the image stage between them is
            only the visible area. */}
        <header
          data-testid="image-viewer-header"
          className="flex min-h-[calc(3.5rem+var(--safe-area-top))] shrink-0 items-center gap-2 border-b pl-safe-3 pr-safe-3 pt-safe"
        >
          <span className="min-w-0 flex-1 truncate text-body-md">
            {caption}
          </span>
          {!markup && (
            <Button
              ref={markupButton}
              size="sm"
              disabled={!loaded}
              onClick={() => {
                setMarkup(true);
                setMode("comment");
              }}
            >
              <Pencil />
              Markup
            </Button>
          )}
          {!compose && (
            <>
              <FileActions src={src} fileName={fileName} />
              <IconButton
                label="Previous image"
                data-testid="file-lightbox-prev"
                disabled={!onPrevious || busy || !!selected}
                onClick={onPrevious}
              >
                <ChevronLeft />
              </IconButton>
              <span className="hidden text-body-sm text-muted-foreground sm:inline">
                {positionLabel}
              </span>
              <IconButton
                label="Next image"
                data-testid="file-lightbox-next"
                disabled={!onNext || busy || !!selected}
                onClick={onNext}
              >
                <ChevronRight />
              </IconButton>
            </>
          )}
          <IconButton label="Close image" disabled={busy} onClick={close}>
            <X />
          </IconButton>
        </header>
        <div
          ref={setStageElement}
          data-testid="image-viewer-stage"
          className="relative min-h-0 flex-1 overflow-hidden bg-media/dense"
        >
          <img
            ref={image}
            src={src}
            alt={caption}
            className="hidden"
            onLoad={(e) => {
              const target = e.currentTarget;
              if (target.naturalWidth > 0 && target.naturalHeight > 0) {
                setImageSize({
                  width: target.naturalWidth,
                  height: target.naturalHeight,
                });
                setLoaded(true);
              } else {
                void imageRasterSize(target)
                  .then((size) => {
                    setImageSize(size);
                    setLoaded(true);
                  })
                  .catch(() => setLoadError(true));
              }
            }}
            onError={() => setLoadError(true)}
          />
          {!loaded && (
            <p
              role={loadError ? "alert" : "status"}
              className="absolute inset-0 flex items-center justify-center text-media-foreground"
            >
              {loadError
                ? "Unable to load image. Close and try again."
                : "Loading image…"}
            </p>
          )}
          {loaded && markup && !hintDismissed && (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-sticky flex justify-center">
              <div className="surface-overlay pointer-events-auto flex max-w-full items-center gap-2 rounded-lg py-1 pl-3 pr-1 text-body-sm text-overlay-foreground">
                <p>Click or drag to leave a note</p>
                <IconButton
                  className="rounded-lg text-overlay-foreground hover:bg-fill-hover hover:text-overlay-foreground"
                  data-image-markup-hint
                  label="Dismiss markup hint"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHintDismissed(true);
                    if (selected)
                      (noteEditor.current ?? notePopover.current)?.focus();
                    else svg.current?.focus();
                  }}
                >
                  <X aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          )}
          <svg
            ref={svg}
            viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
            className="h-full w-full touch-none select-none"
            aria-label={
              markup
                ? "Image callouts. Press Enter to add a centered note."
                : "Image viewer"
            }
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" && markup && loaded && !frozen) {
                e.preventDefault();
                create({ x: 0.5, y: 0.5, width: 0, height: 0 });
              }
            }}
            onClick={() => {
              if (!backdropClose.current) return;
              backdropClose.current = false;
              closeFromBackdrop();
            }}
            onPointerDown={(e) => {
              backdropClose.current = false;
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              e.currentTarget.setPointerCapture(e.pointerId);
              if (pointers.current.size > 1) {
                gesture.current = null;
                backdropPress.current = null;
                setPreview(null);
                const p = pinchPoints();
                if (p && !busy)
                  pinch.current = {
                    distance: p.distance,
                    zoom,
                    anchor: {
                      x: (p.x - pan.x) / zoom,
                      y: (p.y - pan.y) / zoom,
                    },
                  };
                return;
              }
              if (e.button !== 0) return;
              if (onBackdrop(e)) {
                // An open note is dismissed by this press (the popover's own
                // outside-press handling); only the next one closes.
                backdropPress.current = {
                  pointerId: e.pointerId,
                  clientX: e.clientX,
                  clientY: e.clientY,
                  editing: selected !== null,
                };
                return;
              }
              if (!loaded || frozen) return;
              dismissEditor();
              gesture.current = {
                ...point(e),
                clientX: e.clientX,
                clientY: e.clientY,
                pan,
              };
            }}
            onPointerMove={(e) => {
              if (pointers.current.has(e.pointerId))
                pointers.current.set(e.pointerId, {
                  x: e.clientX,
                  y: e.clientY,
                });
              if (pinch.current && pointers.current.size > 1 && !busy) {
                const p = pinchPoints();
                const initial = pinch.current;
                if (p) {
                  const next = Math.max(
                    1,
                    Math.min(8, (initial.zoom * p.distance) / initial.distance)
                  );
                  setZoom(next);
                  setPan({
                    x: p.x - initial.anchor.x * next,
                    y: p.y - initial.anchor.y * next,
                  });
                }
                return;
              }
              const s = gesture.current;
              if (!s || pointers.current.size !== 1) return;
              if (!markup || mode === "pan") {
                setPan({
                  x: s.pan.x + (e.clientX - s.clientX) / ratio,
                  y: s.pan.y + (e.clientY - s.clientY) / ratio,
                });
              } else {
                const raw = point(e);
                const p = {
                  x: Math.max(0, Math.min(1, raw.x)),
                  y: Math.max(0, Math.min(1, raw.y)),
                };
                setPreview({
                  id: "preview",
                  number: Math.max(0, ...comments.map((c) => c.number)) + 1,
                  x: Math.min(p.x, s.x),
                  y: Math.min(p.y, s.y),
                  width: Math.abs(p.x - s.x),
                  height: Math.abs(p.y - s.y),
                  note: "",
                  recipient: "",
                  sent: false,
                });
              }
            }}
            onPointerUp={(e) => {
              pointers.current.delete(e.pointerId);
              pinch.current = null;
              const press = backdropPress.current;
              backdropPress.current = null;
              if (
                press?.pointerId === e.pointerId &&
                Math.hypot(
                  e.clientX - press.clientX,
                  e.clientY - press.clientY
                ) < 8 &&
                onBackdrop(e)
              ) {
                if (press.editing) dismissEditor();
                // Close on the click that follows, so that click lands on
                // this viewer and can't tap through to the page beneath.
                else backdropClose.current = true;
                return;
              }
              const s = gesture.current;
              gesture.current = null;
              setPreview(null);
              if (!s || !markup || mode === "pan") return;
              const raw = point(e);
              const p = {
                x: Math.max(0, Math.min(1, raw.x)),
                y: Math.max(0, Math.min(1, raw.y)),
              };
              const pin =
                Math.hypot(e.clientX - s.clientX, e.clientY - s.clientY) < 8;
              create({
                x: pin ? s.x : Math.min(s.x, p.x),
                y: pin ? s.y : Math.min(s.y, p.y),
                width: pin ? 0 : Math.abs(p.x - s.x),
                height: pin ? 0 : Math.abs(p.y - s.y),
              });
            }}
            onPointerCancel={(e) => {
              pointers.current.delete(e.pointerId);
              pinch.current = null;
              backdropPress.current = null;
              gesture.current = null;
              setPreview(null);
            }}
          >
            <g
              ref={world}
              transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
            >
              <image
                href={src}
                width={imageSize.width}
                height={imageSize.height}
              />
              {[
                ...(markup && current ? [current] : []),
                ...(preview ? [preview] : []),
              ].map((c) => (
                <rect
                  key={c.id}
                  x={c.x * imageSize.width}
                  y={c.y * imageSize.height}
                  width={c.width * imageSize.width}
                  height={c.height * imageSize.height}
                  fill={`${seatClasses(c.number).color}20`}
                  stroke={seatClasses(c.number).color}
                  strokeWidth={2 / (ratio * zoom)}
                />
              ))}
            </g>
          </svg>
          {loaded &&
            markup &&
            comments.map((c) => {
              const left =
                (stageSize.width - rw) / 2 +
                (pan.x + zoom * c.x * imageSize.width) * ratio;
              const top =
                (stageSize.height - rh) / 2 +
                (pan.y + zoom * c.y * imageSize.height) * ratio;
              return (
                <Popover
                  key={c.id}
                  open={selected === c.id}
                  onOpenChange={(open) => {
                    if (!busy) {
                      if (open) {
                        const previous = newComment.current;
                        if (previous && previous !== c.id) {
                          setComments((cs) =>
                            cs.filter((n) => n.id !== previous)
                          );
                          newComment.current = null;
                        }
                        setEditorNote(c.note);
                        setSelected(c.id);
                      } else if (selected === c.id) dismissEditor();
                      send.reset();
                    }
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant={selected === c.id ? "primary" : "secondary"}
                      className={`absolute min-w-10 rounded-full border text-seat-foreground ${seatClasses(c.number).chip} ${selected === c.id ? "ring-2 ring-media-foreground" : ""}`}
                      style={{
                        borderColor: seatClasses(c.number).color,
                        left: Math.max(0, Math.min(stageSize.width - 40, left)),
                        top: Math.max(0, Math.min(stageSize.height - 32, top)),
                      }}
                      id={`comment-${c.id}`}
                      disabled={busy}
                      aria-label={`Comment ${c.number}${c.sent ? ", sent" : ", draft"}`}
                    >
                      <MessageCircle />
                      <span className="text-body-sm">{c.number}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    ref={notePopover}
                    className="z-viewer-popover w-[min(320px,calc(100vw-24px))] space-y-3"
                    onCloseAutoFocus={(e) => {
                      e.preventDefault();
                      requestAnimationFrame(() => {
                        if (selectedRef.current !== null) return;
                        (
                          document.getElementById(`comment-${c.id}`) ??
                          svg.current
                        )?.focus();
                      });
                    }}
                    collisionPadding={12}
                    side={stageSize.width < 640 ? "bottom" : "right"}
                    onEscapeKeyDown={(e) => {
                      e.stopPropagation();
                      if (busy) e.preventDefault();
                    }}
                    onInteractOutside={(e) => {
                      const target = e.detail.originalEvent.target;
                      if (
                        busy ||
                        (target instanceof Element &&
                          target.closest(
                            "[data-image-share], [data-image-markup-hint]"
                          ))
                      )
                        e.preventDefault();
                    }}
                  >
                    {c.sent ? (
                      <>
                        <p className="whitespace-pre-wrap break-words text-body-md">
                          {c.note}
                        </p>
                        <p className="text-body-sm text-muted-foreground">
                          Posted to{" "}
                          {agents.find((a) => a.id === c.recipient)?.name ??
                            c.recipient}
                        </p>
                        {c.delivered === false && (
                          <p className="text-body-sm text-danger">
                            Agent delivery failed. Retry from the conversation.
                          </p>
                        )}
                        <a
                          className="block text-body-sm underline"
                          href={
                            c.location
                              ? (() => {
                                  const loc = agentTurnLocation(
                                    c.location.streamId,
                                    {
                                      blockId: c.location.blockId,
                                      threadId: c.location.threadId,
                                    }
                                  );
                                  return loc.pathname + loc.search;
                                })()
                              : `/agents/${encodeURIComponent(c.recipient)}`
                          }
                        >
                          Open conversation
                        </a>
                        <Button size="sm" onClick={() => setSelected(null)}>
                          Close note
                        </Button>
                      </>
                    ) : (
                      <>
                        <label className="sr-only" htmlFor={`note-${c.id}`}>
                          Comment {c.number}
                        </label>
                        <Textarea
                          ref={noteEditor}
                          autoFocus
                          id={`note-${c.id}`}
                          maxLength={4000}
                          placeholder="Add a note…"
                          value={editorNote}
                          disabled={frozen}
                          onChange={(e) => setEditorNote(e.target.value)}
                        />
                        <div className="flex items-center justify-end gap-2">
                          {newComment.current !== c.id && (
                            <Button
                              size="sm"
                              variant="danger"
                              className="mr-auto"
                              disabled={frozen}
                              onClick={() => {
                                setShareAttempt(null);
                                setComments((cs) =>
                                  cs.filter((n) => n.id !== c.id)
                                );
                                setSelected(null);
                                send.reset();
                              }}
                            >
                              Delete
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={dismissEditor}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={frozen || !editorNote.trim()}
                            onClick={() => {
                              update(c.id, {
                                note: editorNote.trim(),
                                copyId: undefined,
                                metadataId: undefined,
                              });
                              newComment.current = null;
                              setSelected(null);
                            }}
                          >
                            Save
                          </Button>
                        </div>
                      </>
                    )}
                  </PopoverContent>
                </Popover>
              );
            })}
        </div>
        <footer
          data-testid="image-viewer-footer"
          className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t bg-background pb-safe-2 pl-safe-2 pr-safe-2 pt-2"
        >
          <div className="mr-auto flex justify-center">
            <div className="surface-overlay flex items-center gap-1 rounded-full p-1 text-overlay-foreground">
              {markup && (
                <IconButton
                  className="text-overlay-foreground"
                  label="Comment mode"
                  pressed={mode === "comment"}
                  onClick={() => setMode("comment")}
                >
                  <MessageCircle />
                </IconButton>
              )}
              <IconButton
                className="text-overlay-foreground"
                label="Pan image"
                pressed={mode === "pan"}
                onClick={() => setMode("pan")}
              >
                <Hand />
              </IconButton>
              <IconButton
                className="text-overlay-foreground"
                label="Zoom out"
                onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
              >
                <Minus />
              </IconButton>
              <Button
                variant="ghost"
                size="sm"
                className="text-overlay-foreground tabular-nums"
                aria-label="Fit image"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <IconButton
                className="text-overlay-foreground"
                label="Zoom in"
                onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
              >
                <Plus />
              </IconButton>
            </div>
          </div>
          {compose && (
            <>
              <Button size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <span
                data-image-share
                className="inline-flex"
                onPointerDown={(e) => {
                  if (selected) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
              >
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!!selected || !loaded}
                  onClick={finishCompose}
                >
                  Done
                </Button>
              </span>
            </>
          )}
          {markup && !compose && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={leaveMarkup}
              >
                Cancel markup
              </Button>
              <div className="w-full min-w-0 sm:w-auto sm:min-w-72 sm:max-w-[min(50vw,42rem)]">
                <Select
                  value={shareRecipient || undefined}
                  disabled={frozen}
                  onValueChange={(value) => {
                    setRecipient(value);
                    setShareAttempt(null);
                    send.reset();
                  }}
                >
                  <SelectTrigger
                    aria-label="Agent"
                    className="h-auto min-h-8 w-full py-1 [&>span]:line-clamp-none pointer-coarse:min-h-11"
                  >
                    <SelectValue placeholder="Choose agent">
                      <span className="block whitespace-normal break-words text-left">
                        {agents.find((a) => a.id === shareRecipient)?.name ??
                          (shareRecipient || "Choose agent")}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="z-viewer-menu w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)]"
                    collisionPadding={12}
                  >
                    {agents.map((a) => (
                      <SelectItem
                        key={a.id}
                        value={a.id}
                        className="whitespace-normal break-words"
                      >
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span
                data-image-share
                className="inline-flex"
                onPointerDown={(e) => {
                  if (selected) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
              >
                <Button
                  size="sm"
                  variant="primary"
                  disabled={
                    busy ||
                    !!selected ||
                    !loaded ||
                    !shareRecipient ||
                    (!unshared.length && !shareAttempt && !pendingPost)
                  }
                  onClick={share}
                >
                  {busy
                    ? "Sharing…"
                    : `Share with agent${unshared.length ? ` (${unshared.length})` : ""}`}
                </Button>
              </span>
            </>
          )}
          {markup && send.isError && (
            <p
              role="alert"
              className="w-full text-center text-body-sm text-danger"
            >
              {send.error.message} Notes are kept. Retry sharing; if delivery is
              uncertain, check the conversation.
            </p>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
