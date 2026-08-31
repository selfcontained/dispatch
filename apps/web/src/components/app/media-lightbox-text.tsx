import { useEffect, useMemo, useRef, useState } from "react";

import { highlightCode } from "@/components/app/media-lightbox-syntax";
import { LogStream } from "@/components/ui/log-stream";
import { Markdown } from "@/components/ui/markdown";

// `identityKey` (the file name) tells a src change apart from a real
// navigation: an agent rewriting the open file changes `src` (cache-buster)
// without changing identityKey. On that in-place refresh we keep the old
// content mounted while the new text loads instead of dropping to the
// loading state, so the scroll container never unmounts and the browser
// preserves scrollTop across the swap for free. A real navigation (name
// changes) clears content immediately, which is what resets scroll to top.
function useFetchedText(
  src: string,
  identityKey: string
): {
  content: string | null;
  error: string | null;
} {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    const isRefresh = lastIdentityRef.current === identityKey;
    lastIdentityRef.current = identityKey;

    if (!isRefresh) setContent(null);
    setError(null);
    let cancelled = false;
    fetch(src)
      .then((response) => {
        if (!response.ok)
          throw new Error(`Failed to load (${response.status})`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((fetchError) => {
        if (!cancelled) setError(String(fetchError));
      });
    return () => {
      cancelled = true;
    };
  }, [src, identityKey]);

  return { content, error };
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
}: {
  content: string;
  fileName: string;
}): JSX.Element {
  const highlightedHtml = useMemo(
    () => highlightCode(content, fileName),
    [content, fileName]
  );

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

export function MarkdownViewer({
  src,
  fileName,
}: {
  src: string;
  fileName: string;
}): JSX.Element {
  const { content, error } = useFetchedText(src, fileName);

  if (error) return <TextError error={error} />;
  if (content === null) return <LoadingText />;

  return (
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
  const { content, error } = useFetchedText(src, fileName);

  if (error) return <TextError error={error} />;
  if (content === null) return <LoadingText />;

  return <TextViewer content={content} fileName={fileName} />;
}
