import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { atomFamily } from "jotai/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Hand,
  MessageCircle,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { agentListQuery } from "@/hooks/use-agents";
import { createClientId } from "@/lib/client-id";
import { api, ApiError } from "@/lib/api";
import { atomWithLocalStorage } from "@/lib/store";
import type { FileItem } from "./types";
import { FileActions } from "./file-lightbox-actions";

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
};
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

/** Image callouts use normalized, oriented image coordinates; sent notes are also in the stream. */
export function ImageComments({
  file,
  src,
  caption,
  positionLabel,
  onClose,
  onPrevious,
  onNext,
}: {
  file: FileItem;
  src: string;
  caption: string;
  positionLabel: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}): JSX.Element {
  const [comments, setComments] = useAtom(
    commentsFamily(`${file.url}:${file.updatedAt}`)
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"comment" | "pan">("comment");
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
    enabled: selected !== null,
  });
  const pathAgent = window.location.pathname.match(/\/agents\/([^/]+)/)?.[1];
  const defaultRecipient = pathAgent ?? file.ownerAgentId ?? "";
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
  const update = (id: string, patch: Partial<Callout>) =>
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const create = (region: Pick<Callout, "x" | "y" | "width" | "height">) => {
    const c: Callout = {
      ...region,
      id: createClientId(),
      number: Math.max(0, ...comments.map((c) => c.number)) + 1,
      note: "",
      sent: false,
      recipient: defaultRecipient,
    };
    setComments((cs) => [...cs, c]);
    setSelected(c.id);
  };
  const send = useMutation({
    mutationFn: async (c: Callout) => {
      if (!image.current || !loaded || !c.recipient || !c.note.trim())
        throw new Error("Choose an agent and write a note.");
      let copyId = c.copyId;
      if (!copyId) {
        // Bound export memory and keep a new filename/identity. Never overwrite the source.
        const scale = Math.min(
          1,
          2560 / Math.max(imageSize.width, imageSize.height)
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(imageSize.width * scale);
        canvas.height = Math.round(imageSize.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to create annotated copy.");
        ctx.drawImage(image.current, 0, 0, canvas.width, canvas.height);
        const x = c.x * canvas.width,
          y = c.y * canvas.height;
        ctx.strokeStyle = "#fb923c";
        ctx.lineWidth = Math.max(3, canvas.width / 400);
        if (c.width || c.height)
          ctx.strokeRect(
            x,
            y,
            c.width * canvas.width,
            c.height * canvas.height
          );
        const r = Math.max(14, canvas.width / 80);
        const bx = Math.max(r, Math.min(canvas.width - r, x));
        const by = Math.max(r, Math.min(canvas.height - r, y));
        ctx.fillStyle = "#9a3412";
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `bold ${r}px sans-serif`;
        ctx.fillText(String(c.number), bx, by);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) =>
              b ? resolve(b) : reject(new Error("Unable to export image.")),
            "image/png"
          )
        );
        const body = new FormData();
        body.append("file", blob, `feedback-${c.id}.png`);
        const uploaded = await api<{ file: { id: number } }>(
          `/api/v1/agents/${encodeURIComponent(c.recipient)}/files`,
          { method: "POST", body }
        );
        copyId = uploaded.file.id;
        update(c.id, { copyId });
      }
      const metadata = {
        schema: "dispatch.image-feedback.v1",
        annotationId: c.id,
        number: c.number,
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
          width: Math.round(
            imageSize.width *
              Math.min(1, 2560 / Math.max(imageSize.width, imageSize.height))
          ),
          height: Math.round(
            imageSize.height *
              Math.min(1, 2560 / Math.max(imageSize.width, imageSize.height))
          ),
        },
        sourceLocation: window.location.pathname + window.location.search,
        region: {
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          units: "normalized",
          origin: "top-left",
        },
        note: c.note.trim(),
      };
      let metadataId = c.metadataId;
      if (!metadataId) {
        const body = new FormData();
        body.append(
          "file",
          new Blob([JSON.stringify(metadata, null, 2)], {
            type: "application/json",
          }),
          `feedback-${c.id}.json`
        );
        const uploaded = await api<{ file: { id: number } }>(
          `/api/v1/agents/${encodeURIComponent(c.recipient)}/files`,
          { method: "POST", body }
        );
        metadataId = uploaded.file.id;
        update(c.id, { metadataId });
      }
      // Stable IDs make response-loss retries safe; an existing block confirms receipt.
      update(c.id, { attempted: true });
      let delivered: boolean | null = null;
      try {
        const result = await api<{ delivered: boolean | null }>(
          `/api/v1/streams/${encodeURIComponent(c.recipient)}/blocks`,
          {
            method: "POST",
            body: JSON.stringify({
              id: c.id,
              text: `${c.note.trim()}\n\nFeedback on ${file.name} · Callout ${c.number}`,
              attachments: [
                {
                  type: "file",
                  fileId: copyId,
                  caption: `Callout ${c.number} on ${file.name}`,
                },
                {
                  type: "file",
                  fileId: metadataId,
                  caption: "Image and callout details",
                },
              ],
            }),
          }
        );
        delivered = result.delivered;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;
        await api(
          `/api/v1/streams/${encodeURIComponent(c.recipient)}/blocks/${c.id}/metadata`
        );
      }
      return { ...c, delivered };
    },
    onSuccess: (c) => {
      update(c.id, { sent: true, delivered: c.delivered });
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
  const busy = send.isPending;
  const close = () => {
    if (!busy) onClose();
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
          if (selected) setSelected(null);
          else close();
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{caption}</DialogTitle>
        <header className="flex min-h-14 items-center gap-2 border-b px-3">
          <span className="min-w-0 flex-1 truncate text-sm">{caption}</span>
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
          <svg
            ref={svg}
            viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
            className="h-full w-full touch-none select-none"
            aria-label="Image callouts. Press Enter to add a centered note."
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" && loaded && !busy) {
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
              if (!loaded || busy || e.button !== 0) return;
              const p = point(e);
              if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
              setSelected(null);
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
              if (mode === "pan") {
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
                  number: 0,
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
              if (!s || mode === "pan") return;
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
                ...(current ? [current] : []),
                ...(preview ? [preview] : []),
              ].map((c) => (
                <rect
                  key={c.id}
                  x={c.x * imageSize.width}
                  y={c.y * imageSize.height}
                  width={c.width * imageSize.width}
                  height={c.height * imageSize.height}
                  fill="#fb923c20"
                  stroke="#fb923c"
                  strokeWidth={2 / (ratio * zoom)}
                />
              ))}
            </g>
          </svg>
          {loaded &&
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
                      setSelected(open ? c.id : null);
                      send.reset();
                    }
                  }}
                >
                  <PopoverAnchor asChild>
                    <Button
                      size="icon"
                      variant={selected === c.id ? "primary" : "default"}
                      className="absolute h-8 w-10 rounded-full border border-orange-300 bg-orange-900 text-white"
                      style={{
                        left: Math.max(0, Math.min(stageSize.width - 40, left)),
                        top: Math.max(0, Math.min(stageSize.height - 32, top)),
                      }}
                      aria-label={`Comment ${c.number}${c.sent ? ", sent" : ", draft"}`}
                      onClick={() => {
                        setSelected(c.id);
                        send.reset();
                      }}
                    >
                      <MessageCircle className="h-4 w-4" />
                      <span className="text-xs">{c.number}</span>
                    </Button>
                  </PopoverAnchor>
                  <PopoverContent
                    className="z-[140] w-[min(320px,calc(100vw-24px))] space-y-3"
                    collisionPadding={12}
                    side={stageSize.width < 640 ? "bottom" : "right"}
                    onEscapeKeyDown={(e) => {
                      e.stopPropagation();
                      if (busy) e.preventDefault();
                    }}
                    onInteractOutside={(e) => {
                      if (busy) e.preventDefault();
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
                          href={`/agents/${encodeURIComponent(c.recipient)}`}
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
                          autoFocus
                          id={`note-${c.id}`}
                          maxLength={4000}
                          placeholder="Add a note…"
                          value={c.note}
                          disabled={busy || c.attempted}
                          onChange={(e) =>
                            update(c.id, {
                              note: e.target.value,
                              copyId: undefined,
                              metadataId: undefined,
                            })
                          }
                        />
                        <div className="flex items-center gap-2">
                          <label htmlFor={`to-${c.id}`} className="text-xs">
                            To
                          </label>
                          <select
                            id={`to-${c.id}`}
                            className="min-w-0 flex-1 rounded border bg-background p-1 text-xs"
                            value={c.recipient}
                            disabled={busy || c.attempted}
                            onChange={(e) =>
                              update(c.id, {
                                recipient: e.target.value,
                                copyId: undefined,
                                metadataId: undefined,
                              })
                            }
                          >
                            <option value="">Choose agent</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={
                              busy || !c.note.trim() || !c.recipient || !loaded
                            }
                            onClick={() => send.mutate(c)}
                          >
                            {busy ? "Sending…" : "Send"}
                          </Button>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setComments((cs) =>
                              cs.filter((n) => n.id !== c.id)
                            );
                            setSelected(null);
                            send.reset();
                          }}
                        >
                          Delete draft
                        </Button>
                        {send.isError && (
                          <p role="alert" className="text-xs text-destructive">
                            {send.error.message} Your note is kept. If delivery
                            is uncertain, check the conversation before
                            retrying.
                          </p>
                        )}
                      </>
                    )}
                  </PopoverContent>
                </Popover>
              );
            })}
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <div className="flex items-center gap-1 rounded-full border border-white/20 bg-black/80 p-1 text-white">
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
          {loaded && !comments.length && (
            <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-xs text-white/70">
              Click or drag to leave a note
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
