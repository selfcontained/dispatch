import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

type Point = { x: number; y: number };

type ImageTransform = Point & {
  scale: number;
};

export const MIN_IMAGE_SCALE = 1;
export const MAX_IMAGE_SCALE = 8;
const DOUBLE_TAP_ZOOM = 2.5;

function distanceBetween(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function midpointBetween(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

export function useZoomableImage({
  src,
  onPrevious,
  onNext,
}: {
  src: string;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    transform: ImageTransform;
  } | null>(null);
  const pinchRef = useRef<{
    distance: number;
    midpoint: Point;
    transform: ImageTransform;
  } | null>(null);
  const swipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(
    null
  );
  const movedRef = useRef(false);
  const transformRef = useRef<ImageTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransform] = useState<ImageTransform>(
    transformRef.current
  );

  const clampTransform = useCallback((next: ImageTransform): ImageTransform => {
    const viewport = viewportRef.current;
    const image = imageRef.current;
    const scale = Math.min(
      MAX_IMAGE_SCALE,
      Math.max(MIN_IMAGE_SCALE, next.scale)
    );

    if (!viewport || !image || scale === MIN_IMAGE_SCALE) {
      return { scale, x: 0, y: 0 };
    }

    const maxX = Math.max(
      0,
      (image.offsetWidth * scale - viewport.clientWidth) / 2
    );
    const maxY = Math.max(
      0,
      (image.offsetHeight * scale - viewport.clientHeight) / 2
    );

    return {
      scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const updateTransform = useCallback(
    (next: ImageTransform) => {
      const clamped = clampTransform(next);
      transformRef.current = clamped;
      setTransform(clamped);
    },
    [clampTransform]
  );

  const reset = useCallback(() => {
    updateTransform({ scale: 1, x: 0, y: 0 });
  }, [updateTransform]);

  useEffect(() => {
    reset();
    pointersRef.current.clear();
  }, [reset, src]);

  useEffect(() => {
    const onResize = () => updateTransform(transformRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateTransform]);

  const zoomAt = useCallback(
    (nextScale: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      const previous = transformRef.current;
      if (!viewport) return;

      const rect = viewport.getBoundingClientRect();
      const focalX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const focalY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const scale = Math.min(
        MAX_IMAGE_SCALE,
        Math.max(MIN_IMAGE_SCALE, nextScale)
      );
      const ratio = scale / previous.scale;

      updateTransform({
        scale,
        x: focalX - centerX - (focalX - centerX - previous.x) * ratio,
        y: focalY - centerY - (focalY - centerY - previous.y) * ratio,
      });
    },
    [updateTransform]
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    movedRef.current = false;

    const pointers = [...pointersRef.current.values()];
    if (pointers.length === 2) {
      swipeRef.current = null;
      pinchRef.current = {
        distance: distanceBetween(pointers[0], pointers[1]),
        midpoint: midpointBetween(pointers[0], pointers[1]),
        transform: transformRef.current,
      };
      dragRef.current = null;
    } else if (pointers.length === 1) {
      if (
        event.pointerType !== "mouse" &&
        transformRef.current.scale === MIN_IMAGE_SCALE
      ) {
        swipeRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          currentX: event.clientX,
          currentY: event.clientY,
        };
      }
      dragRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        transform: transformRef.current,
      };
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const previousPointer = pointersRef.current.get(event.pointerId);
    if (
      previousPointer &&
      Math.hypot(
        event.clientX - previousPointer.x,
        event.clientY - previousPointer.y
      ) > 2
    ) {
      movedRef.current = true;
    }
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (swipeRef.current?.pointerId === event.pointerId) {
      swipeRef.current.currentX = event.clientX;
      swipeRef.current.currentY = event.clientY;
    }

    const pointers = [...pointersRef.current.values()];
    if (pointers.length === 2 && pinchRef.current) {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const pinch = pinchRef.current;
      const currentMidpoint = midpointBetween(pointers[0], pointers[1]);
      const rect = viewport.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const scale = Math.min(
        MAX_IMAGE_SCALE,
        Math.max(
          MIN_IMAGE_SCALE,
          pinch.transform.scale *
            (distanceBetween(pointers[0], pointers[1]) / pinch.distance)
        )
      );
      const ratio = scale / pinch.transform.scale;

      updateTransform({
        scale,
        x:
          currentMidpoint.x -
          centerX -
          (pinch.midpoint.x - centerX - pinch.transform.x) * ratio,
        y:
          currentMidpoint.y -
          centerY -
          (pinch.midpoint.y - centerY - pinch.transform.y) * ratio,
      });
    } else if (pointers.length === 1 && dragRef.current) {
      const drag = dragRef.current;
      updateTransform({
        ...drag.transform,
        x: drag.transform.x + event.clientX - drag.pointerX,
        y: drag.transform.y + event.clientY - drag.pointerY,
      });
    }
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const swipe =
      swipeRef.current?.pointerId === event.pointerId ? swipeRef.current : null;
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const remaining = [...pointersRef.current.values()];
    pinchRef.current = null;
    if (remaining.length === 1) {
      dragRef.current = {
        pointerX: remaining[0].x,
        pointerY: remaining[0].y,
        transform: transformRef.current,
      };
      return;
    }
    dragRef.current = null;

    if (swipe && transformRef.current.scale === MIN_IMAGE_SCALE) {
      const deltaX = swipe.currentX - swipe.startX;
      const deltaY = swipe.currentY - swipe.startY;
      swipeRef.current = null;
      if (Math.abs(deltaX) >= 60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
        if (deltaX > 0) onPrevious?.();
        else onNext?.();
        lastTapRef.current = null;
        return;
      }
    }

    if (!movedRef.current && event.pointerType !== "mouse") {
      const now = Date.now();
      const lastTap = lastTapRef.current;
      if (
        lastTap &&
        now - lastTap.time < 300 &&
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30
      ) {
        zoomAt(
          transformRef.current.scale > 1 ? 1 : DOUBLE_TAP_ZOOM,
          event.clientX,
          event.clientY
        );
        lastTapRef.current = null;
      } else {
        lastTapRef.current = {
          time: now,
          x: event.clientX,
          y: event.clientY,
        };
      }
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    zoomAt(transformRef.current.scale * factor, event.clientX, event.clientY);
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    zoomAt(
      transformRef.current.scale > 1 ? 1 : DOUBLE_TAP_ZOOM,
      event.clientX,
      event.clientY
    );
  };

  return {
    viewportRef,
    imageRef,
    transform,
    reset,
    zoomAt,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
    handleWheel,
    handleDoubleClick,
  };
}
