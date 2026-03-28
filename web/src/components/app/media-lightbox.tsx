import { type TouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, Download } from "lucide-react";
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

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".sh": "bash", ".bash": "bash",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
  ".html": "xml", ".xml": "xml", ".css": "css", ".sql": "sql",
  ".md": "markdown", ".swift": "swift", ".kt": "kotlin", ".java": "java",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".rb": "ruby", ".php": "php", ".lua": "lua", ".r": "r",
  ".ex": "elixir", ".exs": "elixir", ".erl": "erlang", ".hs": "haskell",
  ".diff": "diff", ".patch": "diff", ".ini": "ini", ".cfg": "ini", ".conf": "ini",
  ".zig": "zig", ".nim": "nim", ".m": "objectivec",
};

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".csv", ".log", ".xml",
  ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".sh",
  ".sql", ".diff", ".patch", ".env", ".ini", ".cfg", ".conf", ".swift",
  ".kt", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".lua",
  ".zig", ".nim", ".r", ".m", ".ex", ".exs", ".erl", ".hs",
]);

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

type MediaLightboxItem = {
  src: string;
  caption: string;
  file: {
    name: string;
    source?: "screenshot" | "stream" | "simulator" | "text";
  };
};

type MediaLightboxProps = {
  item: MediaLightboxItem | null;
  currentIndex: number;
  totalItems: number;
  setLightboxIndex: (nextIndex: number | null) => void;
};

function TextViewer({ src, fileName }: { src: string; fileName: string }): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    let cancelled = false;
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        return res.text();
      })
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [src]);

  const handleCopy = useCallback(() => {
    if (!content) return;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  const handleDownload = useCallback(() => {
    if (!content) return;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName.replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+/, "");
    a.click();
    URL.revokeObjectURL(url);
  }, [content, fileName]);

  const displayName = fileName.replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+/, "");

  const highlightedHtml = useMemo(() => {
    if (!content) return null;
    const dot = fileName.lastIndexOf(".");
    const ext = dot !== -1 ? fileName.slice(dot).toLowerCase() : "";
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

  if (error) {
    return <div className="grid h-full place-items-center text-sm text-destructive">{error}</div>;
  }

  if (content === null) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleDownload}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            size="sm"
            variant={copied ? "default" : "ghost"}
            className={copied ? "h-7 gap-1.5 px-2 text-xs" : "h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"}
            onClick={handleCopy}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied!" : "Copy"}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {highlightedHtml ? (
          <pre className="p-4 text-sm leading-relaxed"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml }} /></pre>
        ) : (
          <pre className="p-4 text-sm leading-relaxed text-foreground"><code>{content}</code></pre>
        )}
      </div>
    </div>
  );
}

const SWIPE_THRESHOLD_PX = 48;

export function MediaLightbox({
  item,
  currentIndex,
  totalItems,
  setLightboxIndex
}: MediaLightboxProps): JSX.Element | null {
  const touchStartXRef = useRef<number | null>(null);

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < totalItems - 1;

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

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartXRef.current = event.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStartXRef.current === null) {
      return;
    }

    const endX = event.changedTouches[0]?.clientX ?? touchStartXRef.current;
    const deltaX = endX - touchStartXRef.current;
    touchStartXRef.current = null;

    if (deltaX <= -SWIPE_THRESHOLD_PX && canGoNext) {
      setLightboxIndex(currentIndex + 1);
      return;
    }

    if (deltaX >= SWIPE_THRESHOLD_PX && canGoPrev) {
      setLightboxIndex(currentIndex - 1);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] grid grid-rows-[auto_1fr_auto] gap-3 bg-black/90 p-4 sm:p-6"
      data-testid="media-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          setLightboxIndex(null);
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
          {totalItems > 0 ? `${currentIndex + 1} / ${totalItems}` : ""}
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Previous media item"
            data-testid="media-lightbox-prev"
            disabled={!canGoPrev}
            size="icon"
            variant="ghost"
            onClick={() => setLightboxIndex(currentIndex - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button onClick={() => setLightboxIndex(null)}>Close</Button>
          <Button
            aria-label="Next media item"
            data-testid="media-lightbox-next"
            disabled={!canGoNext}
            size="icon"
            variant="ghost"
            onClick={() => setLightboxIndex(currentIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        className="relative grid min-h-0 grid-cols-[minmax(0,1fr)] place-items-center overflow-hidden"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <button
          aria-label="Previous media item"
          className="absolute left-0 top-0 z-10 hidden h-full w-1/5 min-w-12 items-center justify-start bg-gradient-to-r from-black/35 to-transparent pl-2 text-white/70 transition hover:text-white disabled:pointer-events-none disabled:opacity-0 sm:flex"
          disabled={!canGoPrev}
          onClick={() => setLightboxIndex(currentIndex - 1)}
          type="button"
        >
          <ChevronLeft className="h-8 w-8" />
        </button>

        {item.file.source === "text" || isTextFile(item.file.name) ? (
          <div className="h-full w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-surface">
            <TextViewer src={item.src} fileName={item.file.name} />
          </div>
        ) : /\.mp4/i.test(item.src) ? (
          <video
            src={item.src}
            controls
            playsInline
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain sm:max-h-[calc(100vh-9rem)] sm:max-w-[calc(100vw-6rem)]"
          />
        ) : (
          <img
            src={item.src}
            alt={item.caption}
            className="max-h-[calc(100vh-10rem)] max-w-[calc(100vw-2rem)] h-auto w-auto object-contain sm:max-h-[calc(100vh-9rem)] sm:max-w-[calc(100vw-6rem)]"
          />
        )}

        <button
          aria-label="Next media item"
          className="absolute right-0 top-0 z-10 hidden h-full w-1/5 min-w-12 items-center justify-end bg-gradient-to-l from-black/35 to-transparent pr-2 text-white/70 transition hover:text-white disabled:pointer-events-none disabled:opacity-0 sm:flex"
          disabled={!canGoNext}
          onClick={() => setLightboxIndex(currentIndex + 1)}
          type="button"
        >
          <ChevronRight className="h-8 w-8" />
        </button>
      </div>
      <div className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
        <span>{item.caption}</span>
        {item.file.source ? <span className="text-xs uppercase tracking-wide">{item.file.source}</span> : null}
      </div>
    </div>
  );
}
