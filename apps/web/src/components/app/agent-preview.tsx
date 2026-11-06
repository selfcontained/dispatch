import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { Check, Copy, ExternalLink, Monitor, X } from "lucide-react";
import { useCopyText } from "@/hooks/use-copy";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { hiddenAgentPreviewsAtomFamily } from "@/lib/store";

export function AgentPreview({ agentId }: { agentId: string }) {
  const [copied, copyText] = useCopyText();
  const [hidden, setHidden] = useAtom(hiddenAgentPreviewsAtomFamily(agentId));
  const { data } = useQuery({
    queryKey: ["agent-preview", agentId],
    queryFn: ({ signal }) =>
      api<{ preview: { url: string; title: string } | null }>(
        `/api/v1/agents/${agentId}/preview`,
        { signal }
      ),
  });
  const preview = data?.preview;
  if (!preview || hidden.includes(preview.url)) return null;
  // Match the attachment contract: safe app paths or absolute web URLs.
  const appPath =
    /^\/(?![/\\])/.test(preview.url) && !/[\t\r\n]/.test(preview.url);
  try {
    if (
      !appPath &&
      !["http:", "https:"].includes(new URL(preview.url).protocol)
    )
      return null;
  } catch {
    return null;
  }
  return (
    <div
      className="flex h-4 min-w-0 items-center gap-3 text-[11px] leading-4"
      data-agent-control="true"
    >
      <Monitor
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        title={preview.url}
        className="flex min-w-0 items-center gap-1 text-status-done hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="truncate">{preview.title || "Preview"}</span>
        <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
      </a>
      <div
        className="ml-auto flex shrink-0 items-center"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          className="text-muted-foreground/60 hover:text-foreground"
          variant="ghost"
          size="icon-sm"
          aria-label={copied ? "Copied preview URL" : "Copy preview URL"}
          title={copied ? "Copied preview URL" : "Copy preview URL"}
          onClick={() => copyText(preview.url)}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          className="text-muted-foreground/60 hover:text-foreground"
          variant="ghost"
          size="icon-sm"
          aria-label={`Hide preview ${preview.title || "Preview"} from sidebar`}
          title="Hide preview from sidebar"
          onClick={(event) => {
            event.stopPropagation();
            setHidden((urls) => [...urls, preview.url]);
          }}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
