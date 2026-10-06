import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";

import { stripTimestamp } from "@/components/app/file-utils";
import { CopyIconButton, DownloadButton } from "@/components/ui/copy-button";
import { useCopyText } from "@/hooks/use-copy";

const HAS_CLIPBOARD_WRITE =
  typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

export function FileActions({
  src,
  fileName,
  isText,
  isMarkdown,
  isHtml,
  textContent,
  downloadName,
}: {
  src: string;
  fileName: string;
  isText?: boolean;
  isMarkdown?: boolean;
  isHtml?: boolean;
  textContent?: string;
  downloadName?: string;
}): JSX.Element {
  const [copied, copyText] = useCopyText();
  const [imageCopied, setImageCopied] = useState(false);
  const imageCopiedTimerRef = useRef<number | null>(null);
  const cachedTextRef = useRef<string | null>(null);

  const displayName = downloadName ?? stripTimestamp(fileName);

  // Pre-fetch text content so it's available synchronously for execCommand copy.
  useEffect(() => {
    cachedTextRef.current = textContent ?? null;
    if (!isText || textContent !== undefined) return;
    const controller = new AbortController();
    void fetch(src, { signal: controller.signal })
      .then((r) => r.text())
      .then((t) => {
        cachedTextRef.current = t;
      })
      .catch(() => {});
    return () => controller.abort();
  }, [src, isText, textContent]);

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
      const text = textContent ?? cachedTextRef.current;
      if (text !== null) copyText(text);
    } else if (HAS_CLIPBOARD_WRITE) {
      const blobPromise = fetch(src).then((r) => r.blob());
      void navigator.clipboard
        .write([new ClipboardItem({ "image/png": blobPromise })])
        .then(markImageCopied)
        .catch(() => {});
    }
  }, [src, isText, textContent, copyText, markImageCopied]);

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
          data-testid="file-lightbox-open-tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Open in tab</span>
        </a>
      )}
      <DownloadButton src={src} fileName={displayName} />
      {showCopy && (
        <CopyIconButton
          copied={showCopied}
          onCopy={handleCopy}
          label={copyLabel}
        />
      )}
    </div>
  );
}
