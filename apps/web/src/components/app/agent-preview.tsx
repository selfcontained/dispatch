import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { ExternalLink, Monitor } from "lucide-react";
import { AgentLinkControls } from "./agent-link-controls";
import { api } from "@/lib/api";
import { hiddenAgentPreviewsAtomFamily } from "@/lib/store";

export function AgentPreview({ agentId }: { agentId: string }) {
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
      <div className="ml-auto">
        <AgentLinkControls
          url={preview.url}
          copyLabel="Copy preview URL"
          copiedLabel="Copied preview URL"
          dismissLabel={`Hide preview ${preview.title || "Preview"} from sidebar`}
          dismissTitle="Hide preview from sidebar"
          onDismiss={() => setHidden((urls) => [...urls, preview.url])}
        />
      </div>
    </div>
  );
}
