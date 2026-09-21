import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * An engine Dispatch can drive and whether this machine has its CLI. The
 * ACP adapters ship inside the Dispatch binary, so the CLI is the only
 * thing that can be missing, and it is the person's to install and sign
 * into. Read so a picker can say so before anyone launches an agent.
 */
export type EngineStatus = {
  id: string;
  label: string;
  installed: boolean;
  path: string | null;
  install: string;
};

export function useEngines(): {
  engines: EngineStatus[];
  /** Absent while the check is in flight, so nothing reads as missing yet. */
  loaded: boolean;
} {
  const { data } = useQuery<{ engines: EngineStatus[] }>({
    queryKey: ["system-engines"],
    queryFn: () => api("/api/v1/system/engines"),
    staleTime: 60_000,
  });
  return { engines: data?.engines ?? [], loaded: data !== undefined };
}

/** What to say under a picker when the chosen engine is not installed. */
export function missingEngine(
  engines: readonly EngineStatus[],
  agentType: string
): EngineStatus | null {
  const engine = engines.find((candidate) => candidate.id === agentType);
  return engine && !engine.installed ? engine : null;
}
