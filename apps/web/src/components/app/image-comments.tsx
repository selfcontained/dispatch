import { useEffect, useRef, useState } from "react";
import { BLOCK_TEXT_MAX_CHARS } from "@dispatch/shared";
import { useAtom, useStore } from "jotai";
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

/** Image callouts use normalized, oriented image coordinates; sent notes are also in the stream. */
export function ImageComments({
  file,
  src,
  caption,
  positionLabel,
  onClose,
  onPrevious,
  onNext,
  onShared,
}: {
  file: FileItem;
  src: string;
  caption: string;
  positionLabel: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onShared?: (location: ImageShareLocation) => void;
}): JSX.Element {
  const store = useStore();
  const imageKey = `${file.url}:${file.updatedAt}`;
  const postedRef = useRef<ShareAttempt | null>(null);
  const pendingPost = storedPost(imageKey) ?? postedRef.current;
  const clearPosted = (batch: ShareAttempt) => {
    const record = postedFamily(`${imageKey}:${batch.id}`);
    // This atom may be new to this tab's store after reload. Prime it before
    // clearing so the persistence helper cannot treat null as an unchanged value.
    store.set(record, { ...batch, attempted: true });
    store.set(record, null);
    postedRef.current = null;
  };
  const [comments, setComments] = useAtom(
    commentsFamily(`${file.url}:${file.updatedAt}`)
  );
  const [shareAttempt, setShareAttempt] = useAtom(
    sharesFamily(`${file.url}:${file.updatedAt}`)
  );
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const noteEditor = useRef<HTMLTextAreaElement>(null);
  const notePopover = useRef<HTMLDivElement>(null);
  const markupButton = useRef<HTMLButtonElement>(null);
  const [markup, setMarkup] = useState(false);
  const [hintDismissed, setHintDismissed] = useAtom(markupHintDismissedAtom);
  const [editorNote, setEditorNote] = useState("");
  const newComment = useRef<string | null>(null);
  const [mode, setMode] = useState<"comment" | "pan">("pan");
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
  const [preview, setPreview] = useState<Callout | null>(null);
  const { data: agents = [] } = useQuery({
    ...agentListQuery,
    enabled:
      selected !== null ||
      comments.some((c) => !c.sent && !!c.note.trim()) ||
      !!shareAttempt,
  });
  const pathAgent = window.location.pathname.match(/\/agents\/([^/]+)/)?.[1];
  const defaultRecipient = pathAgent ?? file.ownerAgentId ?? "";
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
      const text = imageFeedbackMessage(
        batch.items
          .map((c) => {
            const marker = `${c.number}. `;
            return (
              marker +
              c.note.trim().replace(/\n/g, `\n${" ".repeat(marker.length)}`)
            );
          })
          .join("\n\n"),
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
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(imageSize.width * scale);
        canvas.height = Math.round(imageSize.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to create annotated copy.");
        ctx.drawImage(image.current, 0, 0, canvas.width, canvas.height);
        for (const c of batch.items) {
          const x = c.x * canvas.width,
            y = c.y * canvas.height;
          ctx.strokeStyle = seatClasses(c.number).color;
          ctx.lineWidth = Math.max(3, canvas.width / 400);
          if (c.width || c.height)
            ctx.strokeRect(
              x,
              y,
              c.width * canvas.width,
              c.height * canvas.height
            );
          const r = Math.max(14, canvas.width / 80),
            bx = Math.max(r, Math.min(canvas.width - r, x)),
            by = Math.max(r, Math.min(canvas.height - r, y));
          ctx.fillStyle = seatClasses(c.number).ink;
          ctx.beginPath();
          ctx.arc(bx, by, r, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = "white";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `bold ${r}px sans-serif`;
          ctx.fillText(String(c.number), bx, by);
        }
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) =>
              b ? resolve(b) : reject(new Error("Unable to export image.")),
            "image/png"
          )
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
      const metadata = {
        schema: "dispatch.image-feedback.v2",
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
        sourceLocation: window.location.pathname + window.location.search,
        annotations: batch.items.map((c) => ({
          id: c.id,
          number: c.number,
          color: seatClasses(c.number).color,
          region: {
            x: c.x,
            y: c.y,
            width: c.width,
            height: c.height,
            units: "normalized",
            origin: "top-left",
          },
          note: c.note.trim(),
        })),
      };
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
                caption: `Feedback on ${file.name}`,
              },
              {
                type: "file",
                fileId: metadataId,
                caption: "Image and callout details",
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
        className="inset-0 z-[130] h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-background p-0"
        overlayClassName="z-[125]"
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
        <header className="flex min-h-14 items-center gap-2 border-b px-3">
          <span className="min-w-0 flex-1 truncate text-sm">{caption}</span>
          {!markup && (
            <Button
              ref={markupButton}
              size="sm"
              variant="default"
              disabled={!loaded}
              onClick={() => {
                setMarkup(true);
                setMode("comment");
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Markup
            </Button>
          )}
          <FileActions src={src} fileName={file.name} />
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous image"
            data-testid="file-lightbox-prev"
            disabled={!onPrevious || busy || !!selected}
            onClick={onPrevious}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {positionLabel}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next image"
            data-testid="file-lightbox-next"
            disabled={!onNext || busy || !!selected}
            onClick={onNext}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close image"
            disabled={busy}
            onClick={close}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div
          ref={setStageElement}
          className="relative min-h-0 flex-1 overflow-hidden bg-black/90"
        >
          <img
            ref={image}
            src={src}
            alt={caption}
            className="hidden"
            onLoad={(e) => {
              setImageSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              });
              setLoaded(true);
            }}
            onError={() => setLoadError(true)}
          />
          {!loaded && (
            <p
              role={loadError ? "alert" : "status"}
              className="absolute inset-0 flex items-center justify-center text-white"
            >
              {loadError
                ? "Unable to load image. Close and try again."
                : "Loading image…"}
            </p>
          )}
          {loaded && markup && !hintDismissed && (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex justify-center">
              <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-white/20 bg-black/75 py-1 pl-3 pr-1 text-xs text-white shadow-md">
                <p>Click or drag to leave a note</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 rounded-lg text-white hover:bg-white/20 hover:text-white"
                  data-image-markup-hint
                  aria-label="Dismiss markup hint"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setHintDismissed(true);
                    if (selected)
                      (noteEditor.current ?? notePopover.current)?.focus();
                    else svg.current?.focus();
                  }}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
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
            onPointerDown={(e) => {
              pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
              e.currentTarget.setPointerCapture(e.pointerId);
              if (pointers.current.size > 1) {
                gesture.current = null;
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
              if (!loaded || frozen || e.button !== 0) return;
              const p = point(e);
              if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
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
                      size="icon"
                      variant={selected === c.id ? "primary" : "default"}
                      className={`absolute h-8 w-10 rounded-full border text-white ${seatClasses(c.number).chip} ${selected === c.id ? "ring-2 ring-white" : ""}`}
                      style={{
                        borderColor: seatClasses(c.number).color,
                        left: Math.max(0, Math.min(stageSize.width - 40, left)),
                        top: Math.max(0, Math.min(stageSize.height - 32, top)),
                      }}
                      id={`comment-${c.id}`}
                      disabled={busy}
                      aria-label={`Comment ${c.number}${c.sent ? ", sent" : ", draft"}`}
                    >
                      <MessageCircle className="h-4 w-4" />
                      <span className="text-xs">{c.number}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    ref={notePopover}
                    className="z-[140] w-[min(320px,calc(100vw-24px))] space-y-3"
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
                        <p className="whitespace-pre-wrap break-words text-sm">
                          {c.note}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Posted to{" "}
                          {agents.find((a) => a.id === c.recipient)?.name ??
                            c.recipient}
                        </p>
                        {c.delivered === false && (
                          <p className="text-xs text-destructive">
                            Agent delivery failed. Retry from the conversation.
                          </p>
                        )}
                        <a
                          className="block text-xs underline"
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
                              variant="destructive"
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
        <footer className="flex flex-wrap items-center justify-center gap-2 border-t bg-background p-2">
          <div className="mr-auto flex justify-center">
            <div className="flex items-center gap-1 rounded-full border border-white/20 bg-black/80 p-1 text-white">
              {markup && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-white"
                  aria-label="Comment mode"
                  aria-pressed={mode === "comment"}
                  onClick={() => setMode("comment")}
                >
                  <MessageCircle className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="text-white"
                aria-label="Pan image"
                aria-pressed={mode === "pan"}
                onClick={() => setMode("pan")}
              >
                <Hand className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-white"
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                className="text-white"
                aria-label="Fit image"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-white"
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {markup && (
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
                    className="h-auto min-h-9 w-full [&>span]:line-clamp-none"
                    title={
                      agents.find((a) => a.id === shareRecipient)?.name ??
                      shareRecipient
                    }
                  >
                    <SelectValue placeholder="Choose agent">
                      <span className="block whitespace-normal break-words text-left">
                        {agents.find((a) => a.id === shareRecipient)?.name ??
                          (shareRecipient || "Choose agent")}
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="z-[150] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-24px)]"
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
              className="w-full text-center text-xs text-destructive"
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
