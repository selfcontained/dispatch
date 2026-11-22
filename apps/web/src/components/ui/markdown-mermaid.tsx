import { useEffect, useId, useState } from "react";
import { Check, Code2, Image } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
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
      <div className="not-prose my-4 rounded-md border border-danger/line bg-danger/tint p-3">
        <div className="flex items-start gap-2">
          <p className="m-0 flex-1 text-body-md font-medium text-danger">
            Mermaid render failed
          </p>
          <IconButton
            label="Copy Mermaid source"
            data-testid="copy-mermaid-source"
            size="icon-sm"
            className="text-danger hover:bg-danger/tint hover:text-danger"
            onClick={() => copySource(code)}
          >
            {sourceCopied ? <Check /> : <Code2 />}
          </IconButton>
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-body-sm text-danger">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="not-prose my-4 rounded-md border border-border bg-surface-subtle p-3 text-body-md text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-primary/soft animate-pulse" />
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
        <IconButton
          label="Copy Mermaid source"
          data-testid="copy-mermaid-source"
          size="icon-sm"
          onClick={() => copySource(code)}
        >
          {sourceCopied ? <Check /> : <Code2 />}
        </IconButton>
        <IconButton
          label="Copy Mermaid SVG"
          data-testid="copy-mermaid-svg"
          size="icon-sm"
          onClick={() => {
            if (svg) copySvg(svg);
          }}
        >
          {svgCopied ? <Check /> : <Image />}
        </IconButton>
      </div>
      <div
        className="[&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}
