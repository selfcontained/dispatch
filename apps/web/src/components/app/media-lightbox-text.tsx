import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { highlightCode } from "@/components/app/media-lightbox-syntax";
import { LogStream } from "@/components/ui/log-stream";
import { Markdown } from "@/components/ui/markdown";

// `fileName` (stable, unlike `src`) tells a real navigation apart from an
// in-place refresh: an agent rewriting the open file changes `src` (cache-
// buster) without changing fileName. `placeholderData` keeps showing the
// previous fetch's text while a same-file refetch is in flight — content
// only clears when fileName itself changes, which is what resets scroll to
// top on a real navigation (see the scroll-container comments below).
function useFetchedText(
  src: string,
  fileName: string
): {
  content: string | null;
  error: string | null;
  // True when a same-file refresh failed and `content` is the last good
  // fetch rather than what's actually on disk right now — distinct from
  // `error`, which only fires when there's nothing to fall back to.
  isStale: boolean;
} {
  const { data, error, isError } = useQuery({
    queryKey: ["media-lightbox-text", fileName, src],
    queryFn: async () => {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      return response.text();
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === fileName ? previousData : undefined,
    // One quick retry covers the common transient case (the file mid-write)
    // for free, before falling back to the retained copy below.
    retry: 1,
    retryDelay: 250,
    // `src` (cache-busted per refresh) is part of the key, so every
    // in-place refresh of a live-updating file is a distinct cache entry —
    // don't hold the default 5min of them.
    gcTime: 30_000,
  });

  // React Query drops `data` back to undefined on a failed fetch, which
  // would otherwise turn a refresh failure (e.g. the file mid-write, or
  // deleted) into the exact lost-content-and-position experience this hook
  // exists to prevent. Keep the last successfully fetched text for the
  // current file so a failed refresh falls back to it instead of an error.
  const lastGoodRef = useRef<{ fileName: string; content: string } | null>(
    null
  );
  useEffect(() => {
    if (data !== undefined) lastGoodRef.current = { fileName, content: data };
  }, [data, fileName]);
  const retained =
    lastGoodRef.current?.fileName === fileName
      ? lastGoodRef.current.content
      : undefined;

  return {
    content: data ?? retained ?? null,
    error: isError && retained === undefined ? String(error) : null,
    isStale: data === undefined && retained !== undefined,
  };
}

function StaleBanner(): JSX.Element {
  return (
    <div
      role="status"
      className="flex-none border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      Couldn't load the latest update — showing the last version that loaded.
    </div>
  );
}

function LoadingText(): JSX.Element {
  return (
    <div className="grid h-full place-items-center text-sm text-[hsl(var(--log-stream-muted-foreground))]">
      Loading...
    </div>
  );
}

function TextError({ error }: { error: string }): JSX.Element {
  return (
    <div className="grid h-full place-items-center text-sm text-destructive">
      {error}
    </div>
  );
}

function TextViewer({
  content,
  fileName,
  isStale,
}: {
  content: string;
  fileName: string;
  isStale: boolean;
}): JSX.Element {
  const highlightedHtml = useMemo(
    () => highlightCode(content, fileName),
    [content, fileName]
  );

  return (
    <div className="flex h-full flex-col">
      {isStale && <StaleBanner key="stale-banner" />}
      {/* Scroll container: must stay mounted across an in-place content
          refresh (see useFetchedText) — that's what preserves scrollTop.
          Explicit key so an adjacent StaleBanner mounting/unmounting can't
          shift this out of its reconciliation slot and force a remount. */}
      <LogStream
        key="scroll-container"
        className="min-h-0 flex-1 overflow-auto p-0"
      >
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
    </div>
  );
}

export function MarkdownViewer({
  src,
  fileName,
  onStaleChange,
}: {
  src: string;
  fileName: string;
  onStaleChange?: (isStale: boolean) => void;
}): JSX.Element {
  const { content, error, isStale } = useFetchedText(src, fileName);
  useEffect(() => {
    onStaleChange?.(isStale);
  }, [isStale, onStaleChange]);

  if (error) return <TextError error={error} />;
  if (content === null) return <LoadingText />;

  return (
    <div className="flex h-full flex-col">
      {isStale && <StaleBanner key="stale-banner" />}
      {/* Scroll container: must stay mounted across an in-place content
          refresh (see useFetchedText) — that's what preserves scrollTop.
          Explicit key so an adjacent StaleBanner mounting/unmounting can't
          shift this out of its reconciliation slot and force a remount. */}
      <div
        key="scroll-container"
        className="min-h-0 flex-1 overflow-auto bg-background p-4"
      >
        <Markdown headingAccents>{content}</Markdown>
      </div>
    </div>
  );
}

export function TextFileViewer({
  src,
  fileName,
  onStaleChange,
}: {
  src: string;
  fileName: string;
  onStaleChange?: (isStale: boolean) => void;
}): JSX.Element {
  const { content, error, isStale } = useFetchedText(src, fileName);
  useEffect(() => {
    onStaleChange?.(isStale);
  }, [isStale, onStaleChange]);

  if (error) return <TextError error={error} />;
  if (content === null) return <LoadingText />;

  return <TextViewer content={content} fileName={fileName} isStale={isStale} />;
}
