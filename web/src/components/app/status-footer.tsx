import { Database, Image as ImageIcon, Server, Wifi } from "lucide-react";

import { ServiceStatus } from "@/components/app/service-status";
import { type ConnState, type ServiceState } from "@/components/app/types";

type StatusFooterProps = {
  connState: ConnState;
  apiState: ServiceState;
  dbState: ServiceState;
  mediaState: ServiceState;
  serviceDotClass: (state: ServiceState) => string;
};

export function StatusFooter({
  connState,
  apiState,
  dbState,
  mediaState,
  serviceDotClass
}: StatusFooterProps): JSX.Element {
  return (
    <footer className="grid h-11 grid-cols-4 items-center border-t-2 border-border bg-[#11120f] px-3 pb-[env(safe-area-inset-bottom)] text-[10px] text-muted-foreground sm:text-xs">
      <ServiceStatus
        icon={<Wifi className="h-3.5 w-3.5" />}
        label="WS"
        value={connState}
        dotClass={serviceDotClass(
          connState === "connected" ? "ok" : connState === "reconnecting" ? "checking" : "down"
        )}
      />
      <ServiceStatus icon={<Server className="h-3.5 w-3.5" />} label="API" value={apiState} dotClass={serviceDotClass(apiState)} />
      <ServiceStatus
        icon={<Database className="h-3.5 w-3.5" />}
        label="DB"
        value={dbState}
        dotClass={serviceDotClass(dbState)}
      />
      <ServiceStatus
        icon={<ImageIcon className="h-3.5 w-3.5" />}
        label="Media"
        value={mediaState}
        dotClass={serviceDotClass(mediaState)}
      />
    </footer>
  );
}
