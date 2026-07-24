import { useQuery } from "@tanstack/react-query";
import { type ServiceState } from "@/components/app/types";
import { api, DatabaseUnavailableError } from "@/lib/api";
import {
  recordHealthPollFire,
  recordHealthPollSkip,
} from "@/lib/energy-metrics";

type HealthData = {
  apiState: ServiceState;
  dbState: ServiceState;
  startupState: "ready" | "initializing" | "database_unavailable";
  startupError?: string;
};

export function useHealth(enabled: boolean): HealthData {
  const { data } = useQuery<HealthData>({
    queryKey: ["health"],
    queryFn: async () => {
      if (document.hidden) {
        recordHealthPollSkip();
        throw new Error("skipped — tab hidden");
      }
      recordHealthPollFire();
      let health: { status: string; db: string; error?: string };
      try {
        health = await api<{ status: string; db: string; error?: string }>(
          "/api/v1/health"
        );
      } catch (error) {
        if (error instanceof DatabaseUnavailableError) {
          return {
            apiState: "down",
            dbState: "down",
            startupState: "database_unavailable",
            startupError: error.message,
          };
        }
        throw error;
      }
      return {
        apiState: health.status === "ok" ? "ok" : "down",
        dbState: health.db === "ok" ? "ok" : "down",
        startupState:
          health.status === "ok"
            ? "ready"
            : health.status === "database_unavailable"
              ? "database_unavailable"
              : "initializing",
        startupError: (health as { error?: string }).error,
      };
    },
    enabled,
    refetchInterval: 8000,
  });

  return (
    data ?? {
      apiState: "checking",
      dbState: "checking",
      startupState: "initializing",
    }
  );
}
