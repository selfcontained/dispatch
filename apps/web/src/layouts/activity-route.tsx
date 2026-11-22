import { useNavigate, useParams } from "react-router-dom";
import { BarChart3, History } from "lucide-react";
import { ActivityPane } from "@/components/app/activity-pane";
import { cn } from "@/lib/utils";
import { SectionShell } from "./section-shell";
import { useDashboardContext } from "@/components/app/dashboard-context";
import { RowButton } from "@/components/ui/row-button";

const ACTIVITY_SECTIONS = [
  { id: "metrics", label: "Metrics", icon: BarChart3 },
  { id: "history", label: "History", icon: History },
] as const;

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
            <div className="section-label">Activity</div>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {ACTIVITY_SECTIONS.map(({ id, label, icon: Icon }) => {
              const selected = (activityTab ?? "metrics") === id;
              return (
                <RowButton
                  key={id}
                  selected={selected}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => {
                    if (isMobile) setMobileLeftOpen(false);
                    navigate(`/activity/${id}`, { replace: true });
                  }}
                  className={cn(
                    "border px-3 py-3 text-body-md",
                    selected
                      ? "border-primary/tint-strong"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-icon-md shrink-0" />
                  {label}
                </RowButton>
              );
            })}
          </nav>
        </div>
      }
    >
      <ActivityPane open={true} initialTab={activityTab} />
    </SectionShell>
  );
}
