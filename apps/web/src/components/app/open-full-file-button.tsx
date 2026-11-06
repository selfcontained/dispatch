import { useSetAtom } from "jotai";
import { filesBrowserStateFamily } from "./files-browser-state";
import { useLocation } from "react-router-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  requestVersion,
}: {
  agentId: string | null;
  workspace: string | null;
  path: string;
  deleted: boolean;
  requestVersion: React.MutableRefObject<number>;
}) {
  const navigate = useProjectNavigate();
  const setBrowser = useSetAtom(
    filesBrowserStateFamily(JSON.stringify([agentId, workspace]))
  );
  const location = useLocation();
  const routeKey = useRef(location.key);
  useLayoutEffect(() => {
    if (routeKey.current !== location.key) {
      routeKey.current = location.key;
      requestVersion.current++;
    }
  }, [location.key, requestVersion]);
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
      aria-label={`View file: ${path}`}
      title={
        unavailable ? "Full file unavailable in the working tree" : "View file"
      }
      onClick={async () => {
        if (unavailable || pending) return;
        const version = ++requestVersion.current;
        const key = location.key;
        const current = () =>
          alive.current &&
          version === requestVersion.current &&
          key === routeKey.current;
        setPending(true);
        try {
          await api(
            `/api/v1/agents/${encodeURIComponent(agentId)}/workspace?${new URLSearchParams({ workspace, path, file: "true" })}`
          );
          if (!current()) return;
          const params = new URLSearchParams(window.location.search);
          for (const key of ["file", "line", "path", "finding"])
            params.delete(key);
          params.set("files.path", path);
          setBrowser((old) => ({ ...old, browse: false }));
          navigate(`/agents/${encodeURIComponent(agentId)}/files?${params}`);
        } catch {
          if (current())
            toast.error(`Full file unavailable in the working tree: ${path}`);
        } finally {
          setPending(false);
        }
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">View file</span>
    </Button>
  );
}
