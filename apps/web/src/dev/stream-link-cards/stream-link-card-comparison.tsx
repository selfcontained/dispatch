import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { Block, ChatAttachment } from "@dispatch/shared";
import { AttachmentList } from "@/components/app/chat/chat-attachment-views";
import { LinkBlockBody } from "@/components/app/chat/block-bodies";
import { Post } from "@/components/app/chat/chat-entries";
import { Markdown } from "@/components/ui/markdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_THEME_ID, THEMES } from "@/hooks/use-theme";

/** Post avatars consume the query cache even for an identity-free fixture.
 * This entry has no live server state: keep requests disabled in its isolated
 * client, and leave the illustrative author without a real agentId.
 */
export function ComparisonProviders({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export const VARIANTS = [
  {
    id: "baseline",
    label: "Baseline",
    description:
      "Current production card: transparent surface and neutral border.",
  },
  {
    id: "surface",
    label: "A · Surface",
    description:
      "A subtle muted surface separates the card from surrounding prose.",
  },
  {
    id: "accent",
    label: "B · Accent",
    description:
      "A restrained primary border and icon distinguish links without a filled surface.",
  },
  {
    id: "balanced",
    label: "C · Balanced",
    description:
      "A muted surface with a softer primary border and icon combines both cues.",
  },
] as const;

const at = "2026-10-29T15:30:00.000Z";
const author = {
  key: "comparison-agent",
  kind: "agent" as const,
  name: "Stream link exploration",
  agentType: "codex",
};
const linkBlock: Extract<Block, { kind: "link" }> = {
  id: "comparison-link",
  streamId: "comparison",
  author: { kind: "agent", agentId: "comparison" },
  toAgentId: null,
  threadId: null,
  replyTo: null,
  text: "",
  attachments: [],
  delivered: null,
  readAt: null,
  createdAt: at,
  updatedAt: at,
  kind: "link",
  state: null,
  data: {
    url: "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/link_role",
    title: "Link semantics and keyboard navigation",
  },
};
const attachments: ChatAttachment[] = [
  {
    type: "link",
    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_text/Wrapping_breaking_text?comparison=stream-link-cards&viewport=narrow&source=review",
  },
  {
    type: "link",
    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/overflow",
    title: "Overflow and truncation reference",
  },
  {
    type: "pr",
    url: "https://github.com/dispatch-example/dispatch/pull/128",
    title: "Keep stream resources easy to scan",
  },
  {
    type: "preview",
    url: "https://preview.example.com/stream-link-cards",
    title: "Stream card exploration",
  },
  {
    type: "link",
    url: "/src/dev/stream-link-cards/index.html#handoff",
    title: "Comparison handoff notes",
  },
];
const attachmentBlock = {
  author: linkBlock.author,
  toAgentId: null,
  attachments,
};
const attachmentContext = {
  agentId: "comparison",
  agentName: author.name,
  onOpenFile: () => undefined,
};

/** Actual stream Post, link block, and attachment paths; no replica card markup. */
export function ComparisonStream(): JSX.Element {
  return (
    <div
      className="comparison-stream rounded-md border border-border bg-background pb-4"
      aria-label="Example stream"
    >
      <div className="border-b border-border px-4 py-3 text-sm font-medium">
        Stream · Link-card exploration
      </div>
      <Post
        author={{ key: "user", kind: "user", name: "You" }}
        at={at}
        grouped={false}
      >
        <Markdown className="text-sm">
          Please share the accessibility reference and the resources for
          reviewing this change.
        </Markdown>
      </Post>
      <Post author={author} at={at} grouped={false} rule>
        <Markdown className="text-sm">
          The reference covers link semantics and keyboard navigation. Start
          here before reviewing the cards below.
        </Markdown>
        <LinkBlockBody block={linkBlock} />
      </Post>
      <Post author={author} at={at} grouped>
        <Markdown className="text-sm">
          Here are the supporting reference, pull request, and preview. The raw
          URL is deliberately long so we can inspect truncation at narrow
          widths.
        </Markdown>
        <AttachmentList block={attachmentBlock} ctx={attachmentContext} />
      </Post>
      <Post author={author} at={at} grouped>
        <Markdown className="text-sm">
          These are illustrative destinations. Compare how the resource cards
          read between ordinary stream messages.
        </Markdown>
      </Post>
    </div>
  );
}

export function StreamLinkCardComparison(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const selected =
    VARIANTS.find((v) => v.id === params.get("variant")) ?? VARIANTS[0];
  const theme =
    THEMES.find((t) => t.id === params.get("theme")) ??
    THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
  const choose = (key: string, value: string) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set(key, value);
      return next;
    });
  // Reuse the existing theme definitions/CSS tokens, without touching app storage.
  useEffect(() => {
    const root = document.documentElement;
    if (theme.id === "default") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme.id);
    root.setAttribute("data-theme-mode", theme.mode);
  }, [theme.id, theme.mode]);

  return (
    <main className="comparison-page h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-4xl space-y-5 px-3 py-6 sm:px-6">
        <header className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            DEV ONLY · DESIGN COMPARISON
          </p>
          <h1 className="text-xl font-semibold">Stream link cards</h1>
          <p className="text-sm text-muted-foreground">
            Compare the current card with three restrained candidates. Content,
            layout, and link behavior are identical; no production style has
            been selected.
          </p>
        </header>
        <div className="max-w-xs space-y-1">
          <label id="comparison-theme-label" className="text-xs font-medium">
            Existing theme
          </label>
          <Select
            value={theme.id}
            onValueChange={(value) => choose("theme", value)}
          >
            <SelectTrigger aria-labelledby="comparison-theme-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label} · {item.mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Tabs
          value={selected.id}
          onValueChange={(value) => choose("variant", value)}
        >
          <TabsList
            className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4"
            aria-label="Card candidate"
          >
            {VARIANTS.map((variant) => (
              <TabsTrigger key={variant.id} value={variant.id}>
                {variant.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {VARIANTS.map((variant) => (
            <TabsContent
              key={variant.id}
              value={variant.id}
              className="space-y-3"
              data-comparison-variant={variant.id}
            >
              <p className="text-sm text-muted-foreground">
                {variant.description}
              </p>
              <ComparisonStream />
            </TabsContent>
          ))}
        </Tabs>
        <footer
          id="handoff"
          className="space-y-2 text-xs leading-5 text-muted-foreground"
        >
          <p>
            Real components: Post → LinkBlockBody / AttachmentList →
            LinkAttachment. Generic URLs, PR, preview, and internal navigation
            retain their existing semantics. File, code, and inline links are
            outside this comparison.
          </p>
          <p>
            All {THEMES.length} existing themes are available, using their
            current tokens. Theme and candidate choices stay in this page’s URL;
            your saved application theme is untouched. Availability does not
            imply every theme has been visually verified.
          </p>
          <p>
            Use Tab to inspect link focus, arrow keys to switch candidate tabs,
            and a narrow viewport to check wrapping. The baseline retains
            current browser focus behavior; candidates show an inset focus ring.
            Cards retain their current titles, secondary labels, truncation, and
            hover behavior.
          </p>
        </footer>
      </div>
    </main>
  );
}
