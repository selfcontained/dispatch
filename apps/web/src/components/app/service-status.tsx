import { type ReactNode } from "react";

import { StatusDot, type StatusDotTone } from "@/components/ui/status-dot";

type ServiceStatusProps = {
  icon: ReactNode;
  label: string;
  value: string;
  dotTone: StatusDotTone;
};

export function ServiceStatus({
  icon,
  label,
  value,
  dotTone,
}: ServiceStatusProps): JSX.Element {
  return (
    <div
      data-testid={`service-status-${label.toLowerCase()}`}
      className="grid grid-cols-[0.875rem_2rem_0.625rem_minmax(0,1fr)] items-center gap-x-2"
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center">
        {icon}
      </span>
      <span>{label}</span>
      <StatusDot
        data-testid={`service-dot-${label.toLowerCase()}`}
        tone={dotTone}
      />
      <span className="hidden truncate uppercase sm:inline">{value}</span>
    </div>
  );
}
