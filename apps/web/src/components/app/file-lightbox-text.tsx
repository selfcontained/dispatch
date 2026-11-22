import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { highlightCode } from "@/components/app/file-lightbox-syntax";
import { LogStream } from "@/components/ui/log-stream";
import { Markdown } from "@/components/ui/markdown";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

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
  error: Error | null;
  retry: () => void;
} {
  const { data, error, isError, refetch } = useQuery({
    queryKey: ["file-lightbox-text", fileName, src],
    queryFn: async () => {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Failed to load (${response.status})`);
      return response.text();
    },
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === fileName ? previousData : undefined,
    // One quick retry covers a transient blip before giving up.
    retry: 1,
    retryDelay: 250,
    // `src` (cache-busted per refresh) is part of the key, so every
    // in-place refresh of a live-updating file is a distinct cache entry —
    // don't hold the default 5min of them.
    gcTime: 30_000,
  });

  return {
    content: data ?? null,
    error: isError ? error : null,
    retry: () => void refetch(),
  };
}

function LoadingText(): JSX.Element {
  return (
    <LoadingSkeleton
      label="Loading the file…"
      className="p-4"
      rowClassName="h-4"
      rows={8}
    />
  );
}

function TextViewer({
  content,
  fileName,
}: {
  content: string;
  fileName: string;
}): JSX.Element {
  const highlightedHtml = useMemo(
    () => highlightCode(content, fileName),
    [content, fileName]
  );

  return (
    // Scroll container: must stay mounted across an in-place content
    // refresh (see useFetchedText) — that's what preserves scrollTop.
    // Don't key this on src/content.
    <LogStream className="syntax-surface min-h-full overflow-auto p-0">
      {highlightedHtml ? (
        <pre className="p-4 text-body-md leading-relaxed">
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      ) : (
        <pre className="p-4 text-body-md leading-relaxed">
          <code>{content}</code>
        </pre>
      )}
    </LogStream>
  );
}

export function MarkdownViewer({
  src,
  fileName,
}: {
  src: string;
  fileName: string;
}): JSX.Element {
  const { content, error, retry } = useFetchedText(src, fileName);

  if (error)
    return (
      <LoadError
        thing="the file"
        error={error}
        onRetry={retry}
        className="m-4"
      />
    );
  if (content === null) return <LoadingText />;

  return (
    // Scroll container: must stay mounted across an in-place content
    // refresh (see useFetchedText) — that's what preserves scrollTop.
    // Don't key this on src/content.
    <div className="h-full overflow-auto bg-background p-4">
      <Markdown headingAccents>{content}</Markdown>
    </div>
  );
}

export function TextFileViewer({
  src,
  fileName,
}: {
  src: string;
  fileName: string;
}): JSX.Element {
  const { content, error, retry } = useFetchedText(src, fileName);

  if (error)
    return (
      <LoadError
        thing="the file"
        error={error}
        onRetry={retry}
        className="m-4"
      />
    );
  if (content === null) return <LoadingText />;

  return <TextViewer content={content} fileName={fileName} />;
}
