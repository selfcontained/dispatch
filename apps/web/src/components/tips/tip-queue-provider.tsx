import { useCallback, useMemo, useRef, useState } from "react";

import { TipQueueContext } from "@/components/tips/tip-queue-context";

type TipClaim = { tipId: string; instanceId: string };

export function TipQueueProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<TipClaim | null>(null);
  const queueRef = useRef<TipClaim[]>([]);

  const requestOpen = useCallback(
    (tipId: string, instanceId: string): boolean => {
      if (active === null) {
        setActive({ tipId, instanceId });
        return true;
      }
      if (active.tipId === tipId) {
        // Only the owning instance holds the grant. Another instance of the
        // same tip is denied without queueing — after the owner dismisses,
        // the tip lands in dismissedTips and no other instance should open.
        return active.instanceId === instanceId;
      }
      if (
        !queueRef.current.some(
          (claim) => claim.tipId === tipId && claim.instanceId === instanceId
        )
      ) {
        queueRef.current.push({ tipId, instanceId });
      }
      return false;
    },
    [active]
  );

  const release = useCallback((tipId: string, instanceId: string) => {
    setActive((current) => {
      if (
        current === null ||
        current.tipId !== tipId ||
        current.instanceId !== instanceId
      ) {
        return current;
      }
      return queueRef.current.shift() ?? null;
    });
  }, []);

  const value = useMemo(
    () => ({ activeTipId: active?.tipId ?? null, requestOpen, release }),
    [active, requestOpen, release]
  );

  return (
    <TipQueueContext.Provider value={value}>
      {children}
    </TipQueueContext.Provider>
  );
}
