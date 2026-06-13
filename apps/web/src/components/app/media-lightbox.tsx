import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  X,
} from "lucide-react";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import lua from "highlight.js/lib/languages/lua";
import r from "highlight.js/lib/languages/r";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import haskell from "highlight.js/lib/languages/haskell";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import objectivec from "highlight.js/lib/languages/objectivec";
import nim from "highlight.js/lib/languages/nim";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("r", r);
hljs.registerLanguage("elixir", elixir);
hljs.registerLanguage("erlang", erlang);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("objectivec", objectivec);
hljs.registerLanguage("nim", nim);

import { Button } from "@/components/ui/button";
import { LogStream } from "@/components/ui/log-stream";
import { Markdown } from "@/components/ui/markdown";
import {
  fileExtension,
  isTextFile,
  stripTimestamp,
} from "@/components/app/media-file-utils";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sh": "bash",
  ".bash": "bash",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".html": "xml",
  ".xml": "xml",
  ".css": "css",
  ".sql": "sql",
  ".md": "markdown",
  ".swift": "swift",
  ".kt": "kotlin",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".r": "r",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".diff": "diff",
  ".patch": "diff",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".zig": "zig",
  ".nim": "nim",
  ".m": "objectivec",
};

function isMarkdownFile(name: string): boolean {
  return fileExtension(name) === ".md";
}

const HAS_CLIPBOARD_WRITE =
  typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;

type MediaLightboxItem = {
  src: string;
  caption: string;
  file: {
    name: string;
    size: number;
    updatedAt: string;
    source?: "screenshot" | "stream" | "simulator" | "text" | "user";
  };
};

type MediaLightboxProps = {
  item: MediaLightboxItem | null;
  currentIndex: number;
  totalItems: number;
  setLightboxIndex: (nextIndex: number | null) => void;
};

function TextViewer({
  content,
  fileName,
}: {
  content: string;
  fileName: string;
}): JSX.Element {
  const highlightedHtml = useMemo(() => {
    const ext = fileExtension(fileName);
    const lang = EXT_TO_LANG[ext];
    if (lang) {
      try {
        return hljs.highlight(content, { language: lang }).value;
      } catch {
        // fall through to auto-detect
      }
    }
    try {
      return hljs.highlightAuto(content).value;
    } catch {
      return null;
    }
  }, [content, fileName]);

  return (
    <LogStream className="min-h-full overflow-auto p-0">
      {highlightedHtml ? (
        <pre className="p-4 text-sm leading-relaxed">
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      ) : (
        <pre className="p-4 text-sm leading-relaxed">
          <code>{content}</code>
        </pre>
      )}
    </LogStream>
  );
}

function useFetchedText(src: string): {
  content: string | null;
  error: string | null;
} {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    let cancelled = false;
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return { content, error };
}

function MarkdownViewer({ src }: { src: string }): JSX.Element {
  const { content, error } = useFetchedText(src);

  if (error) {
    return (
      <div className="grid h-full place-items-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="grid h-full place-items-center text-sm text-[hsl(var(--log-stream-muted-foreground))]">
        Loading...
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background p-4">
      <Markdown>{content}</Markdown>
    </div>
  );
}

function TextFileViewer({
  src,
  fileName,
}: {
  src: string;
  fileName: string;
}): JSX.Element {
  const { content, error } = useFetchedText(src);

  if (error) {
    return (
      <div className="grid h-full place-items-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="grid h-full place-items-center text-sm text-[hsl(var(--log-stream-muted-foreground))]">
        Loading...
      </div>
    );
  }

  return <TextViewer content={content} fileName={fileName} />;
}

function MediaActions({
  src,
  fileName,
  isText,
  isMarkdown,
}: {
  src: string;
  fileName: string;
  isText?: boolean;
  isMarkdown?: boolean;
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

  // Clean up the image-copied timer on unmount.
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
    } else {
      // Images: use Clipboard API (only works on secure contexts / desktop).
      // On mobile non-secure contexts, users can long-press to copy images.
      if (HAS_CLIPBOARD_WRITE) {
        const blobPromise = fetch(src).then((r) => r.blob());
        void navigator.clipboard
          .write([new ClipboardItem({ "image/png": blobPromise })])
          .then(markImageCopied)
          .catch(() => {});
      }
    }
  }, [src, isText, copyText, markImageCopied]);

  const showCopied = isText ? copied : imageCopied;

  const showCopy = isText || HAS_CLIPBOARD_WRITE;
  const copyLabel = isMarkdown ? "Copy source" : "Copy";

  return (
    <div
      className="flex flex-none items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
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

export { MediaActions };

export function MediaLightbox({
  item,
  currentIndex,
  totalItems,
  setLightboxIndex,
}: MediaLightboxProps): JSX.Element | null {
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < totalItems - 1;

  // Allow pinch-to-zoom while lightbox is open by relaxing the viewport meta tag
  useEffect(() => {
    if (!item) return;
    const meta = document.querySelector<HTMLMetaElement>("meta[name=viewport]");
    if (!meta) return;
    const original = meta.content;
    meta.content = "width=device-width, initial-scale=1.0";
    return () => {
      meta.content = original;
    };
  }, [item]);

  useEffect(() => {
    if (!item) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(null);
        return;
      }

      if (event.key === "ArrowLeft" && canGoPrev) {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(currentIndex - 1);
        return;
      }

      if (event.key === "ArrowRight" && canGoNext) {
        event.preventDefault();
        event.stopPropagation();
        setLightboxIndex(currentIndex + 1);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canGoNext, canGoPrev, currentIndex, item, setLightboxIndex]);

  if (!item) {
    return null;
  }

  const isText = item.file.source === "text" || isTextFile(item.file.name);
  const isMarkdown = isMarkdownFile(item.file.name);
  const isDocument = /\.pdf$/i.test(item.file.name);
  const isVideo = /\.mp4/i.test(item.src);
  const displayName = stripTimestamp(item.file.name);

  const sizeLabel =
    item.file.size >= 1024 * 1024
      ? `${(item.file.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(item.file.size / 1024))} KB`;

  return (
    <div
      className="fixed inset-0 z-[120] grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] bg-black/90 p-2 sm:p-6"
      data-testid="media-lightbox"
    >
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3 overflow-hidden rounded-t-lg border border-b-0 border-border bg-surface px-3 py-2 sm:px-4 sm:py-2.5">
        <span className="min-w-0 shrink truncate text-xs font-medium text-foreground sm:text-sm">
          {displayName}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <MediaActions
            src={item.src}
            fileName={item.file.name}
            isText={isText}
            isMarkdown={isMarkdown}
          />
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button
            aria-label="Previous media item"
            data-testid="media-lightbox-prev"
            disabled={!canGoPrev}
            size="icon"
            variant="ghost"
            className="h-11 w-11 sm:h-9 sm:w-9"
            onClick={() => setLightboxIndex(currentIndex - 1)}
          >
            <ChevronLeft className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
            {totalItems > 0 ? `${currentIndex + 1}/${totalItems}` : ""}
          </span>
          <Button
            aria-label="Next media item"
            data-testid="media-lightbox-next"
            disabled={!canGoNext}
            size="icon"
            variant="ghost"
            className="h-11 w-11 sm:h-9 sm:w-9"
            onClick={() => setLightboxIndex(currentIndex + 1)}
          >
            <ChevronRight className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
          <div className="mx-0.5 h-5 w-px bg-border" />
          <Button
            aria-label="Close"
            size="icon"
            variant="ghost"
            className="h-11 w-11 sm:h-9 sm:w-9"
            onClick={() => setLightboxIndex(null)}
          >
            <X className="h-6 w-6 sm:h-5 sm:w-5" />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "mx-auto min-h-0 w-full max-w-4xl overflow-auto border-x border-border touch-pinch-zoom",
          isDocument
            ? "bg-white"
            : isMarkdown
              ? "bg-background"
              : isText
                ? "bg-[hsl(var(--log-stream-bg))]"
                : "bg-black"
        )}
      >
        {isDocument ? (
          <iframe
            src={item.src}
            title={displayName}
            className="h-full w-full"
          />
        ) : isText ? (
          isMarkdown ? (
            <MarkdownViewer src={item.src} />
          ) : (
            <TextFileViewer src={item.src} fileName={item.file.name} />
          )
        ) : isVideo ? (
          <video
            src={item.src}
            controls
            playsInline
            className="max-h-[calc(100vh-12rem)] w-full object-contain"
          />
        ) : (
          <img
            src={item.src}
            alt={item.caption}
            className="max-h-[calc(100vh-12rem)] w-full object-contain"
          />
        )}
      </div>
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 rounded-b-lg border border-t-0 border-border bg-surface px-2 py-1.5 text-xs text-muted-foreground sm:gap-3 sm:px-4 sm:py-2">
        {item.caption ? (
          <span className="min-w-0 truncate">{item.caption}</span>
        ) : null}
        {item.file.source ? (
          <span className="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {item.file.source === "user" ? "your upload" : item.file.source}
          </span>
        ) : null}
        <span className="ml-auto flex-none">{sizeLabel}</span>
        <span className="hidden flex-none sm:inline">
          {new Date(item.file.updatedAt).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
