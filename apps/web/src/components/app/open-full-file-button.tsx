import { useSetAtom } from "jotai";
import { filesBrowserStateFamily } from "./files-browser-state";
import { useSplitPane } from "@/hooks/use-split-pane";
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useProjectNavigate } from "@/hooks/use-projects";

/** Check the working tree before leaving the diff (historical files may be absent). */
export function OpenFullFileButton({
  agentId,
  workspace,
  path,
  deleted,
  isMobile = false,
}: {
  agentId: string | null;
  workspace: string | null;
  path: string;
  deleted: boolean;
  isMobile?: boolean;
}) {
  const navigate = useProjectNavigate();
  const setBrowser = useSetAtom(
    filesBrowserStateFamily(JSON.stringify([agentId, workspace]))
  );
  const { isSplit, splitState, handleTabDrop } = useSplitPane(
    agentId,
    isMobile
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const unavailable = deleted || !agentId || !workspace;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2 text-xs"
      disabled={unavailable || pending}
      aria-label={`Open full file: ${path}`}
      title={
        unavailable
          ? "Full file unavailable in the working tree"
          : "Open full file"
      }
      onClick={async () => {
        if (unavailable || pending) return;
        setPending(true);
        try {
          await api(
            `/api/v1/agents/${encodeURIComponent(agentId)}/workspace?${new URLSearchParams({ workspace, path, file: "true" })}`
          );
          if (!alive.current) return;
          const params = new URLSearchParams(window.location.search);
          for (const key of ["file", "line", "path", "finding"])
            params.delete(key);
          params.set("files.path", path);
          setBrowser((old) => ({ ...old, browse: false }));
          if (
            isSplit &&
            splitState.left !== "files" &&
            splitState.right !== "files"
          ) {
            handleTabDrop(
              "files",
              splitState.left === "changes" ? "left" : "right",
              "changes"
            );
          }
          navigate(`/agents/${encodeURIComponent(agentId)}/files?${params}`);
        } catch {
          if (alive.current)
            toast.error(`Full file unavailable in the working tree: ${path}`);
        } finally {
          setPending(false);
        }
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Open full file</span>
    </Button>
  );
}
