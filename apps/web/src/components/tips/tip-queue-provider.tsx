import { useCallback, useMemo, useRef, useState } from "react";

import { TipQueueContext } from "@/components/tips/tip-queue-context";

type TipClaim = { tipId: string; instanceId: string };

export function TipQueueProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<TipClaim | null>(null);
  // Synchronous source of truth: two open timers can fire in the same tick,
  // before the `active` state from the first grant has committed.
  const activeRef = useRef<TipClaim | null>(null);
  const queueRef = useRef<TipClaim[]>([]);

  // `active` is an intentional dep even though reads go through activeRef:
  // its identity change re-runs waiting TipSpot effects so a queued tip
  // re-requests (and wins) after the previous owner releases.
  const requestOpen = useCallback(
    (tipId: string, instanceId: string): boolean => {
      const current = activeRef.current;
      if (current === null) {
        const claim = { tipId, instanceId };
        activeRef.current = claim;
        setActive(claim);
        return true;
      }
      if (current.tipId === tipId) {
        // Only the owning instance holds the grant. Another instance of the
        // same tip is denied without queueing — after the owner dismisses,
        // the tip lands in dismissedTips and no other instance should open.
        return current.instanceId === instanceId;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
    [active]
  );

  const release = useCallback((tipId: string, instanceId: string) => {
    const current = activeRef.current;
    if (
      current === null ||
      current.tipId !== tipId ||
      current.instanceId !== instanceId
    ) {
      return;
    }
    const next = queueRef.current.shift() ?? null;
    activeRef.current = next;
    setActive(next);
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
