import { useEffect } from "react";

import { Button } from "@/components/ui/button";

type MediaLightboxProps = {
  lightboxSrc: string | null;
  lightboxCaption: string;
  setLightboxSrc: (src: string | null) => void;
};

export function MediaLightbox({
  lightboxSrc,
  lightboxCaption,
  setLightboxSrc
}: MediaLightboxProps): JSX.Element | null {
  useEffect(() => {
    if (!lightboxSrc) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setLightboxSrc(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [lightboxSrc, setLightboxSrc]);

  if (!lightboxSrc) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[120] grid grid-rows-[auto_1fr_auto] gap-3 bg-black/90 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setLightboxSrc(null);
        }
      }}
    >
      <div className="flex justify-end">
        <Button onClick={() => setLightboxSrc(null)}>Close</Button>
      </div>
      <div className="grid min-h-0 place-items-center">
        {/\.mp4/i.test(lightboxSrc) ? (
          <video
            src={lightboxSrc}
            controls
            playsInline
            className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain"
          />
        ) : (
          <img
            src={lightboxSrc}
            alt={lightboxCaption}
            className="max-h-[calc(100vh-8rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain"
          />
        )}
      </div>
      <div className="text-center text-sm text-muted-foreground">{lightboxCaption}</div>
    </div>
  );
}
