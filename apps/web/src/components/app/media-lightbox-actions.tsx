import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink } from "lucide-react";

import { stripTimestamp } from "@/components/app/media-file-utils";
import { Button } from "@/components/ui/button";
import { useCopyText } from "@/hooks/use-copy";

const HAS_CLIPBOARD_WRITE =
  typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

export function MediaActions({
  src,
  fileName,
  isText,
  isMarkdown,
  isHtml,
}: {
  src: string;
  fileName: string;
  isText?: boolean;
  isMarkdown?: boolean;
  isHtml?: boolean;
}): JSX.Element {
  const [copied, copyText] = useCopyText();
  const [imageCopied, setImageCopied] = useState(false);
  const imageCopiedTimerRef = useRef<number | null>(null);
  const cachedTextRef = useRef<string | null>(null);

  const displayName = stripTimestamp(fileName);

  // Pre-fetch text content so it's available synchronously for execCommand copy.
  useEffect(() => {
    cachedTextRef.current = null;
    if (!isText) return;
    const controller = new AbortController();
    void fetch(src, { signal: controller.signal })
      .then((r) => r.text())
      .then((t) => {
        cachedTextRef.current = t;
      })
      .catch(() => {});
    return () => controller.abort();
  }, [src, isText]);

  useEffect(
    () => () => {
      if (imageCopiedTimerRef.current)
        window.clearTimeout(imageCopiedTimerRef.current);
    },
    []
  );

  const markImageCopied = useCallback(() => {
    setImageCopied(true);
    if (imageCopiedTimerRef.current)
      window.clearTimeout(imageCopiedTimerRef.current);
    imageCopiedTimerRef.current = window.setTimeout(
      () => setImageCopied(false),
      2000
    );
  }, []);

  const handleCopy = useCallback(() => {
    if (isText) {
      if (cachedTextRef.current) copyText(cachedTextRef.current);
    } else if (HAS_CLIPBOARD_WRITE) {
      const blobPromise = fetch(src).then((r) => r.blob());
      void navigator.clipboard
        .write([new ClipboardItem({ "image/png": blobPromise })])
        .then(markImageCopied)
        .catch(() => {});
    }
  }, [src, isText, copyText, markImageCopied]);

  const showCopied = isText ? copied : imageCopied;
  const showCopy = isText || HAS_CLIPBOARD_WRITE;
  const copyLabel = isMarkdown || isHtml ? "Copy source" : "Copy";

  return (
    <div
      className="flex flex-none items-center gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {isHtml && (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          title="Open in new tab"
          data-testid="media-lightbox-open-tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Open in tab</span>
        </a>
      )}
      <a
        href={src}
        download={displayName}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
        title="Download"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Download</span>
      </a>
      {showCopy && (
        <Button
          size="sm"
          variant={showCopied ? "default" : "ghost"}
          className={
            showCopied
              ? "h-7 gap-1.5 px-2 text-xs"
              : "h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          }
          onClick={handleCopy}
          title={copyLabel}
          aria-label={copyLabel}
        >
          {showCopied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">
            {showCopied ? "Copied!" : copyLabel}
          </span>
        </Button>
      )}
    </div>
  );
}
