import { Database, Server } from "lucide-react";

import { ServiceStatus } from "@/components/app/service-status";
import { type ServiceState } from "@/components/app/types";

type StatusFooterProps = {
  apiState: ServiceState;
  dbState: ServiceState;
  serviceDotClass: (state: ServiceState) => string;
};

export function StatusFooter({
  apiState,
  dbState,
  serviceDotClass
}: StatusFooterProps): JSX.Element {
  return (
    <footer data-testid="status-footer" className="flex h-11 items-center gap-6 border-t-2 border-border bg-surface px-3 pb-[env(safe-area-inset-bottom)] text-[10px] text-muted-foreground sm:text-xs">
      <ServiceStatus icon={<Server className="h-3.5 w-3.5" />} label="API" value={apiState} dotClass={serviceDotClass(apiState)} />
      <ServiceStatus
        icon={<Database className="h-3.5 w-3.5" />}
        label="DB"
        value={dbState}
        dotClass={serviceDotClass(dbState)}
      />
    </footer>
  );
}
