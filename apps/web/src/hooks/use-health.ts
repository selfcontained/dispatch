import { useQuery } from "@tanstack/react-query";
import { type ServiceState } from "@/components/app/types";
import { api } from "@/lib/api";
import { recordHealthPollFire, recordHealthPollSkip } from "@/lib/energy-metrics";

type HealthData = { apiState: ServiceState; dbState: ServiceState };

export function useHealth(enabled: boolean): HealthData {
  const { data } = useQuery<HealthData>({
    queryKey: ["health"],
    queryFn: async () => {
      if (document.hidden) {
        recordHealthPollSkip();
        throw new Error("skipped — tab hidden");
      }
      recordHealthPollFire();
      const health = await api<{ status: string; db: string }>("/api/v1/health");
      return {
        apiState: health.status === "ok" ? "ok" : "down",
        dbState: health.db === "ok" ? "ok" : "down",
      };
    },
    enabled,
    refetchInterval: 8000,
  });

  return data ?? { apiState: "checking", dbState: "checking" };
}
