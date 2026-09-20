import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";

import { FileActions } from "@/components/app/file-lightbox-actions";
import { ZoomableImage } from "@/components/app/file-lightbox-image";
import {
  MarkdownViewer,
  TextFileViewer,
} from "@/components/app/file-lightbox-text";
import {
  fileExtension,
  isTextFile,
  stripTimestamp,
} from "@/components/app/file-utils";
import { Button } from "@/components/ui/button";
import { type FileItem } from "@/components/app/types";
import { fileItemQueryKey } from "@/hooks/use-files";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type FileLightboxProps = {
  fileId: number | null;
  fileIds: number[];
  setFileId: (fileId: number | null) => void;
};

async function fetchFileItem(fileId: number): Promise<FileItem> {
  const payload = await api<{ file: FileItem }>(`/api/v1/files/${fileId}`);
  return payload.file;
}

function isMarkdownFile(name: string): boolean {
  return fileExtension(name) === ".md";
}

function isHtmlFile(name: string): boolean {
  return fileExtension(name) === ".html";
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as Error & { status?: unknown }).status === 404
  );
}

export { FileActions } from "@/components/app/file-lightbox-actions";

export function FileLightbox({
  fileId,
  fileIds,
  setFileId,
}: FileLightboxProps): JSX.Element | null {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const {
    data: file,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: fileItemQueryKey(fileId ?? 0),
    queryFn: () => fetchFileItem(fileId as number),
    enabled: fileId !== null,
    staleTime: 0,
  });
  const currentIndex = fileId === null ? -1 : fileIds.indexOf(fileId);
  const totalItems = fileIds.length;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < totalItems - 1;
  const fileNotFound = isNotFoundError(error);

  // Keep the page fixed behind the viewer. Image gestures are handled locally,
  // so the browser viewport never needs to zoom or scroll.
  useEffect(() => {
    if (fileId === null) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [fileId]);

  useEffect(() => {
    if (fileId === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setFileId(null);
        return;
      }

      if (event.key === "ArrowLeft" && canGoPrev) {
        event.preventDefault();
        event.stopPropagation();
        setFileId(fileIds[currentIndex - 1] ?? null);
        return;
      }

      if (event.key === "ArrowRight" && canGoNext) {
        event.preventDefault();
        event.stopPropagation();
        setFileId(fileIds[currentIndex + 1] ?? null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoNext, canGoPrev, currentIndex, fileId, fileIds, setFileId]);

  useEffect(() => {
    if (fileId !== null && fileNotFound) setFileId(null);
  }, [fileId, fileNotFound, setFileId]);

  useEffect(() => {
    if (fileId !== null && !file && !fileNotFound) {
      closeButtonRef.current?.focus();
    }
  }, [file, fileId, fileNotFound]);

  if (fileId === null || fileNotFound) return null;

  const src = file ? `${file.url}?t=${encodeURIComponent(file.updatedAt)}` : "";
  const displayName = file ? stripTimestamp(file.name) : "";
  const caption = file ? file.description || displayName : "";
  const isText = file ? file.source === "text" || isTextFile(file.name) : false;
  const isMarkdown = file ? isMarkdownFile(file.name) : false;
  const isHtml = file ? isHtmlFile(file.name) : false;
  const isDocument = file ? /\.pdf$/i.test(file.name) : false;
  const isVideo = file ? /\.mp4/i.test(src) : false;
  const isImage = file ? !isDocument && !isText && !isVideo : true;
  const sizeLabel = file
    ? file.size >= 1024 * 1024
      ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.size / 1024))} KB`
    : "";
  const showLoadError = !file && !!error && !isFetching;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[120] bg-black/90",
        isImage
          ? "overflow-hidden"
          : "grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] p-2 sm:p-6"
      )}
      data-testid="file-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={file ? caption : "File viewer"}
    >
      <div
        className={cn(
          "flex w-full items-center gap-3 overflow-hidden px-3 py-2 sm:px-4 sm:py-2.5",
          isImage
            ? "absolute inset-x-0 top-0 z-10 border-b border-white/10 bg-black/65 pt-[max(0.5rem,env(safe-area-inset-top))] text-white shadow-lg backdrop-blur"
            : "mx-auto max-w-4xl rounded-t-lg border border-b-0 border-border bg-surface"
        )}
      >
        <span
          className={cn(
            "min-w-0 shrink truncate text-xs font-medium sm:text-sm",
            isImage ? "text-white" : "text-foreground"
          )}
          title={isImage && file?.description ? displayName : undefined}
        >
          {file ? (isImage ? caption : displayName) : "File"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          {file ? (
            <>
              <FileActions
                src={src}
                fileName={file.name}
                isText={isText}
                isMarkdown={isMarkdown}
                isHtml={isHtml}
              />
              <div className="mx-0.5 h-5 w-px bg-border" />
            </>
          ) : null}
          <Button
            aria-label="Previous file item"
            data-testid="file-lightbox-prev"
            disabled={!canGoPrev}
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setFileId(fileIds[currentIndex - 1] ?? null)}
          >
            <ChevronLeft className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <span
            className={cn(
              "hidden text-xs tabular-nums sm:inline",
              isImage ? "text-white/70" : "text-muted-foreground"
            )}
          >
            {totalItems > 0 ? `${currentIndex + 1}/${totalItems}` : ""}
          </span>
          <Button
            aria-label="Next file item"
            data-testid="file-lightbox-next"
            disabled={!canGoNext}
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setFileId(fileIds[currentIndex + 1] ?? null)}
          >
            <ChevronRight className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button
            ref={closeButtonRef}
            aria-label="Close"
            size="icon"
            variant="ghost"
            className={cn(
              "h-11 w-11 sm:h-9 sm:w-9",
              isImage && "text-white hover:bg-white/15 hover:text-white"
            )}
            onClick={() => setFileId(null)}
          >
            <X className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          isImage
            ? "absolute inset-0"
            : "mx-auto min-h-0 w-full max-w-4xl overflow-auto border-x border-border",
          isDocument || isHtml
            ? "bg-white"
            : isMarkdown
              ? "bg-background"
              : isText
                ? "bg-[hsl(var(--log-stream-bg))]"
                : "bg-black"
        )}
      >
        {!file ? (
          <div className="flex h-full min-h-screen items-center justify-center px-4 text-white">
            {showLoadError ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <p role="alert" className="text-sm text-white/70">
                  Unable to load this file item.
                </p>
                <Button
                  variant="ghost"
                  className="border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white"
                  onClick={() => void refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-sm text-white/70"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading file…
              </div>
            )}
          </div>
        ) : isDocument ? (
          <iframe src={src} title={displayName} className="h-full w-full" />
        ) : isHtml ? (
          <iframe
            src={src}
            title={displayName}
            // No allow-same-origin: the document gets an opaque origin and
            // cannot reach the Dispatch API or storage.
            sandbox="allow-scripts allow-popups"
            className="h-full min-h-[60vh] w-full"
            data-testid="file-lightbox-html"
          />
        ) : isText ? (
          isMarkdown ? (
            <MarkdownViewer src={src} fileName={file.name} />
          ) : (
            <TextFileViewer src={src} fileName={file.name} />
          )
        ) : isVideo ? (
          <video
            src={src}
            controls
            playsInline
            className="max-h-[calc(100vh-12rem)] w-full object-contain"
          />
        ) : (
          <ZoomableImage
            src={src}
            alt={caption}
            onPrevious={
              canGoPrev
                ? () => setFileId(fileIds[currentIndex - 1] ?? null)
                : undefined
            }
            onNext={
              canGoNext
                ? () => setFileId(fileIds[currentIndex + 1] ?? null)
                : undefined
            }
          />
        )}
      </div>
      {file && !isImage && (
        <div className="mx-auto flex w-full max-w-4xl items-center gap-2 rounded-b-lg border border-t-0 border-border bg-surface px-2 py-1.5 text-xs text-muted-foreground sm:gap-3 sm:px-4 sm:py-2">
          <span className="min-w-0 truncate">{caption}</span>
          {file.source ? (
            <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              {file.source === "user" ? "your upload" : file.source}
            </span>
          ) : null}
          <span className="ml-auto flex-none">{sizeLabel}</span>
          <span className="hidden flex-none sm:inline">
            {new Date(file.updatedAt).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
