import { useEffect, useId, useState } from "react";
import { Check, Code2, Image } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { MermaidRenderTheme } from "@/components/ui/markdown-mermaid-theme";
import { useCopyText } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/errors";

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null =
  null;
let mermaidConfigKey: string | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

function getMermaidConfig(theme: MermaidRenderTheme | null) {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    fontFamily: theme?.fontFamily,
    darkMode: theme?.darkMode,
    themeVariables: theme?.themeVariables,
  };
}

async function getMermaid() {
  mermaidPromise ??= import("mermaid")
    .then(({ default: mermaid }) => mermaid)
    .catch((error) => {
      mermaidPromise = null;
      throw error;
    });
  return mermaidPromise;
}

async function ensureMermaidInitialized(theme: MermaidRenderTheme | null) {
  const mermaid = await getMermaid();
  const config = getMermaidConfig(theme);
  const nextConfigKey = JSON.stringify(config);
  if (mermaidConfigKey !== nextConfigKey) {
    mermaid.initialize(config);
    mermaidConfigKey = nextConfigKey;
  }
  return mermaid;
}

async function renderMermaidDiagram({
  code,
  id,
  theme,
}: {
  code: string;
  id: string;
  theme: MermaidRenderTheme | null;
}) {
  const renderTask = mermaidRenderQueue
    .catch(() => {})
    .then(async () => {
      const mermaid = await ensureMermaidInitialized(theme);
      return mermaid
        .render(`dispatch-mermaid-${id}`, code)
        .then(({ svg }) => svg);
    });

  mermaidRenderQueue = renderTask.then(() => undefined);
  return renderTask;
}

export function MermaidBlock({
  code,
  theme,
}: {
  code: string;
  theme: MermaidRenderTheme | null;
}): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceCopied, copySource] = useCopyText();
  const [svgCopied, copySvg] = useCopyText();
  const id = useId().replace(/:/g, "-");

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setSvg(null);
      setError(null);

      try {
        const renderedSvg = await renderMermaidDiagram({ code, id, theme });
        if (!cancelled) setSvg(renderedSvg);
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, id, theme]);

  if (error) {
    return (
      <div className="not-prose my-4 rounded-md border border-destructive/40 bg-destructive/10 p-3">
        <div className="flex items-start gap-2">
          <p className="m-0 flex-1 text-sm font-medium text-destructive">
            Mermaid render failed
          </p>
          <Button
            aria-label="Copy Mermaid source"
            data-testid="copy-mermaid-source"
            title="Copy Mermaid source"
            size="icon"
            type="button"
            variant="ghost"
            className="h-11 w-11 text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-7 sm:w-7"
            onClick={() => copySource(code)}
          >
            {sourceCopied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Code2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="not-prose my-4 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary/70 animate-pulse" />
          <span>Rendering diagram...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="not-prose my-4 overflow-x-auto rounded-md border border-border bg-background p-3"
      data-testid="mermaid-diagram"
    >
      <div className="mb-2 flex items-center justify-end gap-2 sm:gap-1">
        <Button
          aria-label="Copy Mermaid source"
          data-testid="copy-mermaid-source"
          title="Copy Mermaid source"
          size="icon"
          type="button"
          variant="ghost"
          className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
          onClick={() => copySource(code)}
        >
          {sourceCopied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Code2 className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          aria-label="Copy Mermaid SVG"
          data-testid="copy-mermaid-svg"
          title="Copy Mermaid SVG"
          size="icon"
          type="button"
          variant="ghost"
          className="h-11 w-11 text-muted-foreground hover:text-foreground sm:h-7 sm:w-7"
          onClick={() => {
            if (svg) copySvg(svg);
          }}
        >
          {svgCopied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Image className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <div
        className="[&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
