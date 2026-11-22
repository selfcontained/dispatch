import { useRef, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_CROP, drawAvatarCrop, encodeAvatar } from "./prepare-avatar";
import { Alert } from "@/components/ui/alert";

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
  const [error, setError] = useState<unknown>();
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
        if (!open) onClose();
      }}
    >
      <DialogContent
        size="sm"
        busy={saving}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Frame your photo</DialogTitle>
          <DialogDescription>
            Drag to position your photo, then zoom to get the framing you want.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
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
            className="mx-auto aspect-square w-full max-w-64 shrink-0 touch-none cursor-move rounded-full border border-border bg-muted focus-ring"
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
          <label className="text-body-sm font-medium">
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
          <p className="text-body-sm text-muted-foreground">
            We’ll crop and resize it for you. Your original photo stays on your
            device.
          </p>
        </DialogBody>
        {error ? (
          <Alert title="Couldn’t save your photo." error={error} />
        ) : null}
        <DialogFooter
          start={
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setCrop(DEFAULT_CROP)}
            >
              Reset crop
            </Button>
          }
        >
          <DialogCancel />
          <Button
            variant="primary"
            pending={saving}
            onClick={async () => {
              setSaving(true);
              setError(undefined);
              try {
                await onSave(encodeAvatar(photo, crop));
                onClose();
              } catch (err) {
                setError(err);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save photo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
