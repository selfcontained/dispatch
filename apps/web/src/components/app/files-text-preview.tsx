import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { ScrollBar } from "@/components/ui/scroll-area";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FilesHighlight } from "./files-highlight";

function useFileHighlight(text: string, fileName: string) {
  const [result, setResult] = useState<
    (FilesHighlight & { source: string; fileName: string }) | null
  >(null);
  useEffect(() => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const finish = (data: FilesHighlight) => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
      setResult({ ...data, source: text, fileName });
    };
    // Keep startup, parsing and tokenization off the UI thread. A slow grammar
    // is terminated, leaving the immediately available plain-text preview.
    try {
      worker = new Worker(
        new URL("./files-highlight.worker.ts", import.meta.url),
        { type: "module" }
      );
      worker.onmessage = (event: MessageEvent<FilesHighlight>) =>
        finish(event.data);
      worker.onerror = () => finish({ language: null, lines: null });
      timer = setTimeout(() => finish({ language: null, lines: null }), 2000);
      worker.postMessage({ text, fileName });
    } catch {
      finish({ language: null, lines: null });
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [text, fileName]);
  return result?.source === text && result.fileName === fileName
    ? result
    : null;
}

/** Continuous native scrolling with only the visible lines mounted. The worker
 * highlights the document once, preserving multiline syntax across windows. */
export function FilesTextPreview({
  text,
  fileName,
}: {
  text: string;
  fileName: string;
}) {
  const codeRef = useRef<HTMLDivElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [horizontal, setHorizontal] = useState({ width: 0, viewport: 0 });
  useEffect(() => {
    const code = codeRef.current;
    const content = contentRef.current;
    if (!code || !content) return;
    const measure = () =>
      setHorizontal({ width: code.scrollWidth, viewport: code.clientWidth });
    const observer = new ResizeObserver(measure);
    observer.observe(code);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, []);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: element.clientHeight }))
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const lines = useMemo(() => text.split("\n"), [text]);
  const highlight = useFileHighlight(text, fileName);
  const first = Math.max(
    0,
    Math.min(lines.length - 1, Math.floor((viewport.top - 12) / 24) - 20)
  );
  const end = Math.min(
    lines.length,
    first + Math.ceil(viewport.height / 24) + 40
  );
  const windowPadding = {
    paddingTop: first * 24 + 12,
    paddingBottom: (lines.length - end) * 24 + 12,
  };
  // Keep horizontal extent stable as shorter/longer lines enter the window.
  const columns = useMemo(
    () =>
      lines.reduce(
        (max, line) =>
          Math.max(
            max,
            [...line.slice(0, 4000)].reduce(
              (column, char) =>
                char === "\t" ? column + 8 - (column % 8) : column + 1,
              0
            ) + (line.length > 4000 ? 64 : 0)
          ),
        0
      ),
    [lines]
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b px-3 py-1 text-xs text-muted-foreground">
        <span>
          {lines.length.toLocaleString()} lines ·{" "}
          {highlight?.language ?? (highlight ? "Plain text" : "Highlighting…")}
        </span>
      </div>
      <div
        ref={viewportRef}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setViewport((v) => ({ ...v, top }));
        }}
        className="syntax-surface min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-x-none"
        data-testid="file-text-preview"
        tabIndex={0}
        aria-label="File source"
      >
        {/* One native vertical scroller aligns both columns. Only the code
            column scrolls horizontally: even elastic scrolling cannot carry
            the gutter along because it is a sibling, not a sticky child. */}
        <div className="flex min-w-0 items-stretch font-mono text-xs leading-6">
          <div
            aria-hidden="true"
            data-testid="file-gutter"
            className="files-gutter shrink-0 touch-pan-y select-none border-r border-border py-3 text-right text-muted-foreground/60"
            style={{
              width: `${Math.max(6, String(lines.length).length + 3)}ch`,
              ...windowPadding,
            }}
          >
            {lines.slice(first, end).map((_, index) => (
              <span
                key={index}
                data-testid="file-line-number"
                className="block h-6 px-3"
              >
                {first + index + 1}
              </span>
            ))}
          </div>
          <div
            ref={codeRef}
            onScroll={(event) => {
              const control = horizontalRef.current;
              if (
                control &&
                control.scrollLeft !== event.currentTarget.scrollLeft
              )
                control.scrollLeft = event.currentTarget.scrollLeft;
            }}
            className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="file-code-scroll"
            tabIndex={0}
            aria-label="Code horizontal scroll"
          >
            <div
              ref={contentRef}
              className="w-max min-w-full"
              style={{ ...windowPadding, width: `calc(${columns}ch + 24px)` }}
            >
              {lines.slice(first, end).map((line, index) => {
                const lineIndex = first + index;
                const html = highlight?.lines?.[lineIndex];
                return html !== undefined ? (
                  <code
                    key={lineIndex}
                    data-testid="file-source-line"
                    className="hljs block h-6 whitespace-pre px-3"
                    dangerouslySetInnerHTML={{ __html: html || " " }}
                  />
                ) : (
                  <code
                    key={lineIndex}
                    data-testid="file-source-line"
                    className="block h-6 whitespace-pre px-3"
                  >
                    {line.length > 4000
                      ? `${line.slice(0, 4000)} … [long line clipped; Copy contents for full text]`
                      : line || " "}
                  </code>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {horizontal.width > horizontal.viewport && (
        <div
          className="syntax-surface flex shrink-0 font-mono text-xs"
          data-testid="file-horizontal-control"
        >
          <div
            className="shrink-0"
            style={{
              width: `${Math.max(6, String(lines.length).length + 3)}ch`,
            }}
          />
          <ScrollAreaPrimitive.Root
            type="always"
            className="relative h-3 min-w-0 shrink-0"
            style={{ width: horizontal.viewport }}
          >
            <ScrollAreaPrimitive.Viewport
              ref={horizontalRef}
              className="h-full w-full"
              onScroll={(event) => {
                const code = codeRef.current;
                if (code && code.scrollLeft !== event.currentTarget.scrollLeft)
                  code.scrollLeft = event.currentTarget.scrollLeft;
              }}
            >
              <div style={{ width: horizontal.width, height: 1 }} />
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar
              orientation="horizontal"
              aria-label="Scroll file horizontally"
            />
          </ScrollAreaPrimitive.Root>
        </div>
      )}
    </div>
  );
}
