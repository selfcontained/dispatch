import { useSetAtom } from "jotai";
import { filesBrowserStateFamily } from "./files-browser-state";
import { useLocation } from "react-router-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useProjectNavigate } from "@/hooks/use-projects";
import { toast } from "@/components/ui/toast";

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
    <Hint
      label={
        unavailable ? "Full file unavailable in the working tree" : "View file"
      }
    >
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 disabled:pointer-events-auto"
        disabled={unavailable || pending}
        aria-label={`View file: ${path}`}
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
          } catch (error) {
            if (current())
              toast.error(`Couldn’t open ${path}.`, {
                description: "It’s unavailable in the working tree.",
                error,
              });
          } finally {
            setPending(false);
          }
        }}
      >
        <ExternalLink />
        <span className="hidden [@container(min-width:360px)]:inline">
          View file
        </span>
      </Button>
    </Hint>
  );
}
