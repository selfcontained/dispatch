import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

type ServiceStatusProps = {
  icon: ReactNode;
  label: string;
  value: string;
  dotClass: string;
};

export function ServiceStatus({ icon, label, value, dotClass }: ServiceStatusProps): JSX.Element {
  return (
    <div
      data-testid={`service-status-${label.toLowerCase()}`}
      className="grid grid-cols-[0.875rem_2rem_0.625rem_minmax(0,1fr)] items-center gap-x-2"
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center">{icon}</span>
      <span>{label}</span>
      <span data-testid={`service-dot-${label.toLowerCase()}`} className={cn("h-2.5 w-2.5 rounded-full", dotClass)} />
      <span className="hidden truncate uppercase sm:inline">{value}</span>
    </div>
  );
}
