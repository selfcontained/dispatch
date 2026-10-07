import { useNavigate, useParams } from "react-router-dom";
import { BarChart3, History } from "lucide-react";
import { ActivityPane } from "@/components/app/activity-pane";
import { cn } from "@/lib/utils";
import { SectionShell } from "./section-shell";
import { useDashboardContext } from "@/components/app/dashboard-context";

export function ActivityRoute(): JSX.Element {
  const navigate = useNavigate();
  const { tab } = useParams();
  const { isMobile, setMobileLeftOpen } = useDashboardContext();
  const activityTab = tab as "metrics" | "history" | undefined;

  return (
    <SectionShell
      activeSection="activity"
      sidebar={
        <div className="flex h-full min-h-0 flex-col">
          <div className="mt-2 flex h-14 items-center border-b border-border px-3">
            <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activity
            </div>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <button
              type="button"
              onClick={() => {
                if (isMobile) setMobileLeftOpen(false);
                navigate("/activity/metrics", { replace: true });
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                (activityTab ?? "metrics") === "metrics"
                  ? "bg-primary/10 text-foreground border border-primary/20"
                  : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <BarChart3 className="h-3.5 w-3.5 shrink-0" />
              Metrics
            </button>
            <button
              type="button"
              onClick={() => {
                if (isMobile) setMobileLeftOpen(false);
                navigate("/activity/history", { replace: true });
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                activityTab === "history"
                  ? "bg-primary/10 text-foreground border border-primary/20"
                  : "border border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <History className="h-3.5 w-3.5 shrink-0" />
              History
            </button>
          </nav>
        </div>
      }
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ActivityPane open={true} initialTab={activityTab} />
      </div>
    </SectionShell>
  );
}
