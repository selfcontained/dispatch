import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { type FileItem } from "./types";

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
};

/** Dev-only UX exploration. No export, upload, or send API is called. */
export function ImageFeedbackPrototype({
  file,
  src,
  onClose,
}: {
  file: FileItem;
  src: string;
  onClose: () => void;
}): JSX.Element {
  const [regions, setRegions] = useState<Region[]>([]);
  const [pending, setPending] = useState<Region | null>(null);
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"callout" | "pan">("callout");
  const [step, setStep] = useState<"edit" | "review" | "done">("edit");
  const [discard, setDiscard] = useState(false);
  const [size, setSize] = useState({ width: 1000, height: 650 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [destination, setDestination] = useState(
    "Source conversation (example)"
  );
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const start = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    pan: typeof pan;
  } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const point = (event: React.PointerEvent<SVGSVGElement>) => {
    const p = svg.current!.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    const q = p.matrixTransform(world.current!.getScreenCTM()!.inverse());
    return {
      x: Math.max(0, Math.min(size.width, q.x)),
      y: Math.max(0, Math.min(size.height, q.y)),
    };
  };
  const add = (region: Region) => {
    setPending(region);
    setNote("");
    requestAnimationFrame(() => input.current?.focus());
  };
  const close = () => {
    if (regions.length || pending) setDiscard(true);
    else onClose();
  };
  const stroke = Math.max(size.width, size.height) / 300;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="inset-0 z-[130] h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-background p-0 text-foreground"
        overlayClassName="z-[125]"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (discard) setDiscard(false);
          else if (step !== "edit") setStep("edit");
          else close();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Image feedback prototype</DialogTitle>
        <header className="flex flex-wrap items-center gap-3 border-b p-3">
          <div className="mr-auto min-w-0">
            <h2 className="font-semibold">{file.name}</h2>
            <p className="text-xs text-muted-foreground">
              Callout feedback · Prototype · Nothing is sent or saved
            </p>
          </div>
          <Button variant="default" onClick={close}>
            Return to image
          </Button>
        </header>
        {discard ? (
          <div
            className="m-auto max-w-md space-y-4 p-6"
            role="alertdialog"
            aria-label="Discard feedback"
          >
            <h3 className="font-semibold">Discard this feedback?</h3>
            <p>Your original stays unchanged. These notes will be lost.</p>
            <Button autoFocus onClick={() => setDiscard(false)}>
              Keep editing
            </Button>{" "}
            <Button variant="destructive" onClick={onClose}>
              Discard notes
            </Button>
          </div>
        ) : step === "done" ? (
          <div className="m-auto max-w-lg space-y-4 p-6" role="status">
            <h3 className="text-xl font-semibold">Handoff simulated</h3>
            <p>
              {regions.length} notes reviewed for {destination}. No message or
              file was created.
            </p>
            <Button onClick={() => setStep("edit")}>Back to notes</Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 border-b p-2">
              {step === "edit" ? (
                <>
                  <Button
                    variant={mode === "callout" ? "primary" : "default"}
                    aria-pressed={mode === "callout"}
                    onClick={() => setMode("callout")}
                  >
                    Callout
                  </Button>
                  <Button
                    variant={mode === "pan" ? "primary" : "default"}
                    aria-pressed={mode === "pan"}
                    onClick={() => setMode("pan")}
                  >
                    Pan
                  </Button>
                  <Button
                    variant="default"
                    disabled={!loaded || !!pending}
                    onClick={() =>
                      add({
                        x: size.width * 0.4,
                        y: size.height * 0.4,
                        width: size.width * 0.2,
                        height: size.height * 0.2,
                        note: "",
                      })
                    }
                  >
                    Add centered callout
                  </Button>
                  <Button
                    variant="default"
                    disabled={!regions.length || !!pending}
                    onClick={() => setRegions((r) => r.slice(0, -1))}
                  >
                    Undo last note
                  </Button>
                  <Button
                    variant="default"
                    aria-label="Zoom out"
                    onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
                  >
                    −
                  </Button>
                  <Button
                    variant="default"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    Fit · {Math.round(zoom * 100)}%
                  </Button>
                  <Button
                    variant="default"
                    aria-label="Zoom in"
                    onClick={() => setZoom((z) => Math.min(5, z * 1.5))}
                  >
                    +
                  </Button>
                </>
              ) : (
                <Button variant="default" onClick={() => setStep("edit")}>
                  Back to notes
                </Button>
              )}
            </div>
            <div className="grid min-h-0 flex-1 overflow-auto md:grid-cols-[minmax(0,1fr)_340px]">
              <div className="relative flex min-h-[280px] items-center justify-center overflow-hidden bg-black/90 md:min-h-0">
                {!loaded && !error && (
                  <p className="absolute text-white" role="status">
                    Loading original image…
                  </p>
                )}
                {error && (
                  <p className="absolute p-4 text-white" role="alert">
                    Unable to load image. Return to the viewer and try again.
                  </p>
                )}
                <img
                  className="hidden"
                  src={src}
                  alt=""
                  onLoad={(e) => {
                    setSize({
                      width: e.currentTarget.naturalWidth,
                      height: e.currentTarget.naturalHeight,
                    });
                    setLoaded(true);
                  }}
                  onError={() => setError(true)}
                />
                <svg
                  ref={svg}
                  viewBox={`0 0 ${size.width} ${size.height}`}
                  className="max-h-[48vh] w-full touch-none select-none md:h-full md:max-h-full"
                  aria-label="Original image with numbered callouts"
                  role="img"
                  onPointerDown={(e) => {
                    if (step !== "edit" || pending || !loaded || e.button !== 0)
                      return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    start.current = {
                      ...point(e),
                      clientX: e.clientX,
                      clientY: e.clientY,
                      pan,
                    };
                  }}
                  onPointerMove={(e) => {
                    const s = start.current;
                    if (!s) return;
                    if (mode === "pan") {
                      const ctm = svg.current!.getScreenCTM()!;
                      setPan({
                        x: s.pan.x + (e.clientX - s.clientX) / ctm.a,
                        y: s.pan.y + (e.clientY - s.clientY) / ctm.d,
                      });
                    } else {
                      const p = point(e);
                      setPending({
                        x: Math.min(s.x, p.x),
                        y: Math.min(s.y, p.y),
                        width: Math.abs(s.x - p.x),
                        height: Math.abs(s.y - p.y),
                        note: "",
                      });
                    }
                  }}
                  onPointerUp={(e) => {
                    const s = start.current;
                    start.current = null;
                    if (!s || mode === "pan") return;
                    const p = point(e);
                    const isPin =
                      Math.hypot(e.clientX - s.clientX, e.clientY - s.clientY) <
                      8;
                    add({
                      x: isPin ? s.x : Math.min(s.x, p.x),
                      y: isPin ? s.y : Math.min(s.y, p.y),
                      width: isPin ? 0 : Math.abs(s.x - p.x),
                      height: isPin ? 0 : Math.abs(s.y - p.y),
                      note: "",
                    });
                  }}
                  onPointerCancel={() => {
                    start.current = null;
                    setPending(null);
                  }}
                >
                  <g
                    ref={world}
                    transform={
                      step === "edit"
                        ? `translate(${pan.x} ${pan.y}) scale(${zoom})`
                        : undefined
                    }
                  >
                    <image href={src} width={size.width} height={size.height} />
                    {[...regions, ...(pending ? [pending] : [])].map((r, i) => (
                      <g key={i}>
                        {r.width > 0 && (
                          <rect
                            x={r.x}
                            y={r.y}
                            width={r.width}
                            height={r.height}
                            fill="#f9731620"
                            stroke="#fb923c"
                            strokeWidth={stroke}
                          />
                        )}
                        <circle
                          cx={r.x}
                          cy={r.y}
                          r={stroke * 5}
                          fill="#9a3412"
                          stroke="white"
                          strokeWidth={stroke / 2}
                        />
                        <text
                          x={r.x}
                          y={r.y}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={stroke * 6}
                          fill="white"
                        >
                          {i + 1}
                        </text>
                      </g>
                    ))}
                  </g>
                </svg>
              </div>
              <aside className="space-y-3 overflow-auto border-l p-4">
                <h3 className="font-semibold">
                  {step === "review"
                    ? "Review feedback package"
                    : "Callouts & notes"}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {step === "review"
                    ? "Proposed delivery: annotated copy plus readable numbered notes. This preview does not export a file."
                    : mode === "callout"
                      ? "Click an area for a pin, or drag to outline it. Then attach a note."
                      : "Drag to pan. Switch to Callout to add a note."}
                </p>
                {!regions.length && !pending && (
                  <p className="text-sm">No callouts yet.</p>
                )}
                {regions.map((r, i) => (
                  <div key={i} className="space-y-2 rounded-md border p-3">
                    <p className="whitespace-pre-wrap break-words text-sm">
                      <strong>{i + 1}.</strong> {r.note}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {Math.round(r.x)}, {Math.round(r.y)} ·{" "}
                      {r.width
                        ? `${Math.round(r.width)} × ${Math.round(r.height)} px`
                        : "pin"}
                    </p>
                    {step === "edit" && (
                      <Button
                        size="sm"
                        variant="default"
                        aria-label={`Delete note ${i + 1}`}
                        onClick={() =>
                          setRegions((rs) =>
                            rs.filter((_, index) => i !== index)
                          )
                        }
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                ))}
                {pending && (
                  <div className="space-y-2">
                    <label
                      htmlFor="callout-note"
                      className="text-sm font-medium"
                    >
                      Note for callout {regions.length + 1}
                    </label>
                    <Textarea
                      ref={input}
                      id="callout-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="What should change here?"
                    />
                    <Button
                      disabled={!note.trim()}
                      onClick={() => {
                        setRegions((rs) => [
                          ...rs,
                          { ...pending, note: note.trim() },
                        ]);
                        setPending(null);
                        setNote("");
                      }}
                    >
                      Save note
                    </Button>{" "}
                    <Button variant="default" onClick={() => setPending(null)}>
                      Cancel note
                    </Button>
                  </div>
                )}
                {step === "review" && (
                  <>
                    <p className="break-words text-xs text-muted-foreground">
                      Original file #{file.id} · {file.name}
                      <br />
                      Version: {file.updatedAt}
                      <br />
                      {size.width} × {size.height} px
                      <br />
                      Location: {window.location.pathname}
                      <br />
                      Derived copy: proposed new identity; original preserved.
                    </p>
                    <label
                      className="block text-sm"
                      htmlFor="feedback-destination"
                    >
                      Simulated destination
                    </label>
                    <select
                      id="feedback-destination"
                      className="w-full rounded-md border bg-background p-2 text-sm"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                    >
                      <option>Source conversation (example)</option>
                      <option>
                        Another agent / new conversation (example)
                      </option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Destination examples only. Exact source-thread routing is
                      not wired in this prototype.
                    </p>
                  </>
                )}
              </aside>
            </div>
            <footer className="flex flex-wrap items-center justify-end gap-3 border-t p-3">
              <span className="mr-auto text-xs text-muted-foreground">
                Local draft · Lost on reload · Original unchanged
              </span>
              {step === "edit" ? (
                <Button
                  disabled={!regions.length || !!pending}
                  onClick={() => setStep("review")}
                >
                  Review feedback
                </Button>
              ) : (
                <>
                  <Button variant="default" onClick={() => setStep("edit")}>
                    Cancel review
                  </Button>
                  <Button onClick={() => setStep("done")}>
                    Confirm simulated handoff
                  </Button>
                </>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
