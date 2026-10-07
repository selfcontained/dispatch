import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_CROP, drawAvatarCrop, encodeAvatar } from "./prepare-avatar";

export function AvatarCropDialog({
  photo,
  onClose,
  onSave,
  onRestoreFocus,
}: {
  photo: HTMLCanvasElement;
  onClose: () => void;
  onRestoreFocus: () => void;
  onSave: (dataUrl: string) => Promise<void>;
}) {
  const [crop, setCrop] = useState(DEFAULT_CROP);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const move = (dx: number, dy: number) => {
    const size = canvas.current?.getBoundingClientRect().width ?? 256;
    const side = Math.min(photo.width, photo.height) / crop.zoom;
    setCrop((current) => ({
      ...current,
      x: clamp(
        current.x - (dx * side) / size / Math.max(1, photo.width - side)
      ),
      y: clamp(
        current.y - (dy * side) / size / Math.max(1, photo.height - side)
      ),
    }));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="max-w-sm overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogTitle>Frame your photo</DialogTitle>
        <DialogDescription>
          Drag to position your photo, then zoom to get the framing you want.
        </DialogDescription>
        <canvas
          ref={(node) => {
            canvas.current = node;
            if (node) drawAvatarCrop(photo, node, crop);
          }}
          width={256}
          height={256}
          role="img"
          tabIndex={0}
          aria-label="Avatar crop preview. Drag or use arrow keys to position."
          data-testid="avatar-crop-preview"
          className="mx-auto aspect-square w-full max-w-64 shrink-0 touch-none cursor-move rounded-full border border-border bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          onPointerDown={(event) => {
            if (saving) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            if (!drag.current || saving) return;
            move(
              event.clientX - drag.current.x,
              event.clientY - drag.current.y
            );
            drag.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (saving) return;
            const delta = (
              {
                ArrowLeft: [-10, 0],
                ArrowRight: [10, 0],
                ArrowUp: [0, -10],
                ArrowDown: [0, 10],
              } as Record<string, number[]>
            )[event.key];
            if (delta) {
              event.preventDefault();
              move(delta[0]!, delta[1]!);
            }
          }}
        />
        <label className="text-sm">
          Zoom
          <Slider
            className="mt-3"
            thumbProps={{ "aria-label": "Photo zoom" }}
            value={[crop.zoom]}
            min={1}
            max={3}
            step={0.05}
            disabled={saving}
            onValueChange={([zoom]) =>
              setCrop((current) => ({ ...current, zoom: zoom! }))
            }
          />
        </label>
        <p className="text-xs text-muted-foreground">
          We’ll crop and resize it for you. Your original photo stays on your
          device.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => setCrop(DEFAULT_CROP)}
          >
            Reset crop
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="default" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  await onSave(encodeAvatar(photo, crop));
                  onClose();
                } catch {
                  setError("Could not save your photo. Please try again.");
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Save photo"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
