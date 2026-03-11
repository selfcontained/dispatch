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
    <div data-testid={`service-status-${label.toLowerCase()}`} className="flex items-center gap-2">
      {icon}
      <span>{label}</span>
      <span data-testid={`service-dot-${label.toLowerCase()}`} className={cn("h-2.5 w-2.5 rounded-full", dotClass)} />
      <span className="truncate uppercase">{value}</span>
    </div>
  );
}
