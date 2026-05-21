import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Check, Code2, Image } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { useCopyText } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

let mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null =
  null;

type MermaidRenderTheme = {
  darkMode: boolean;
  fontFamily: string;
  themeVariables: Record<string, string | boolean>;
};

function hslToken(name: string, styles: CSSStyleDeclaration): string {
  return `hsl(${styles.getPropertyValue(name).trim()})`;
}

function parseHslChannels(color: string): [number, number, number] | null {
  const match = color.match(
    /^hsl\(\s*(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i
  );
  if (!match) return null;
  return [
    Number(match[1]) % 360,
    Number(match[2]) / 100,
    Number(match[3]) / 100,
  ];
}

function lightnessFromHsl(color: string): number | null {
  return parseHslChannels(color)?.[2] ?? null;
}

function useMermaidTheme(): MermaidRenderTheme | null {
  const [themeVersion, setThemeVersion] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setThemeVersion((version) => version + 1);
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });

    return () => observer.disconnect();
  }, []);

  return useMemo(() => {
    void themeVersion;
    if (typeof window === "undefined") return null;

    const styles = window.getComputedStyle(document.documentElement);
    const background = hslToken("--background", styles);
    const foreground = hslToken("--foreground", styles);
    const primary = hslToken("--primary", styles);
    const primaryForeground = hslToken("--primary-foreground", styles);
    const muted = hslToken("--muted", styles);
    const mutedForeground = hslToken("--muted-foreground", styles);
    const border = hslToken("--border", styles);
    const card = hslToken("--card", styles);
    const cardForeground = hslToken("--card-foreground", styles);
    const destructive = hslToken("--destructive", styles);
    const destructiveForeground = hslToken("--destructive-foreground", styles);
    const fontFamily =
      styles.getPropertyValue("--font-terminal").trim() ||
      "system-ui, sans-serif";

    const lightness = lightnessFromHsl(background);
    const darkMode = lightness === null ? true : lightness < 0.5;

    return {
      darkMode,
      fontFamily,
      themeVariables: {
        darkMode,
        background,
        mainBkg: card,
        secondBkg: muted,
        tertiaryColor: muted,
        primaryColor: primary,
        primaryTextColor: primaryForeground,
        primaryBorderColor: border,
        secondaryColor: muted,
        secondaryTextColor: foreground,
        secondaryBorderColor: border,
        tertiaryTextColor: mutedForeground,
        tertiaryBorderColor: border,
        lineColor: mutedForeground,
        textColor: foreground,
        nodeTextColor: cardForeground,
        clusterBkg: background,
        clusterBorder: border,
        defaultLinkColor: mutedForeground,
        titleColor: foreground,
        edgeLabelBackground: background,
        labelBackground: background,
        actorBkg: card,
        actorBorder: border,
        actorTextColor: foreground,
        actorLineColor: mutedForeground,
        signalColor: mutedForeground,
        signalTextColor: foreground,
        c0: card,
        c1: muted,
        c2: background,
        errorBkgColor: destructive,
        errorTextColor: destructiveForeground,
      },
    };
  }, [themeVersion]);
}

async function getMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    return mermaid;
  });
  return mermaidPromise;
}

function MermaidBlock({
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
        const mermaid = await getMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: theme?.fontFamily,
          darkMode: theme?.darkMode,
          themeVariables: theme?.themeVariables,
        });
        const { svg: renderedSvg } = await mermaid.render(
          `dispatch-mermaid-${id}`,
          code
        );
        if (!cancelled) setSvg(renderedSvg);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
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
            className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
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
        Rendering diagram...
      </div>
    );
  }

  return (
    <div
      className="not-prose my-4 overflow-x-auto rounded-md border border-border bg-background p-3"
      data-testid="mermaid-diagram"
    >
      <div className="mb-2 flex items-center justify-end gap-1">
        <Button
          aria-label="Copy Mermaid source"
          data-testid="copy-mermaid-source"
          title="Copy Mermaid source"
          size="icon"
          type="button"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
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
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
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

function getCodeBlock(
  children: ReactNode
): { className?: string; code: string } | null {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (
    !child ||
    !isValidElement<{ className?: string; children?: ReactNode }>(child)
  ) {
    return null;
  }

  const code = child.props.children;
  if (typeof code !== "string") {
    return null;
  }

  return {
    className: child.props.className,
    code: code.replace(/\n$/, ""),
  };
}

type MarkdownProps = {
  children: string;
  className?: string;
  variant?: "default" | "pin";
};

export function Markdown({
  children,
  className,
  variant = "default",
}: MarkdownProps): JSX.Element {
  const mermaidTheme = useMermaidTheme();

  if (variant === "pin") {
    return (
      <div
        className={cn(
          "max-w-none text-xs text-foreground",
          "[&_p]:my-1 [&_p]:[overflow-wrap:anywhere]",
          "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4",
          "[&_li]:my-0.5 [&_li]:[overflow-wrap:anywhere]",
          "[&_strong]:font-semibold [&_em]:italic",
          "[&_pre]:my-1 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-x-hidden [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2",
          "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:break-words [&_code]:whitespace-pre-wrap",
          "[&_table]:my-1 [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[11px]",
          "[&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
          "[&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1",
          className
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          allowedElements={[
            "p",
            "ul",
            "li",
            "strong",
            "em",
            "code",
            "pre",
            "table",
            "thead",
            "tbody",
            "tr",
            "th",
            "td",
          ]}
          unwrapDisallowed
        >
          {children}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        // Use theme CSS variables for colors so it works across all themes
        "text-foreground prose-headings:text-foreground prose-strong:text-foreground",
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5",
        "prose-headings:mt-3 prose-headings:mb-1",
        "prose-pre:bg-muted prose-pre:rounded-md prose-pre:p-2 prose-pre:text-xs prose-pre:overflow-x-auto",
        "prose-code:text-xs prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-primary prose-a:underline",
        "prose-li:text-foreground prose-li:marker:text-muted-foreground",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const block = getCodeBlock(children);
            if (block?.className === "language-mermaid") {
              return <MermaidBlock code={block.code} theme={mermaidTheme} />;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
