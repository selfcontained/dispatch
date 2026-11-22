import { useEffect, useState } from "react";
import { SHEET_SETTLE_FALLBACK_MS } from "@/components/ui/sheet";

/** Keep the last task readable during the shared frame's exit animation. */
export function useTaskDrawerTarget(id: string | null) {
  const [heldId, setHeldId] = useState(id);
  useEffect(() => {
    if (id) {
      setHeldId(id);
      return;
    }
    const timer = window.setTimeout(
      () => setHeldId(null),
      SHEET_SETTLE_FALLBACK_MS
    );
    return () => window.clearTimeout(timer);
  }, [id]);
  return id ?? heldId;
}
