import { useEffect, useRef } from "react";
import { useAtom } from "jotai";

import { BUILD_VERSION } from "@/lib/version";
import { lastSeenVersionAtom } from "@/lib/tips/tips-state";

export function TipsVersionInit() {
  const [lastSeen, setLastSeen] = useAtom(lastSeenVersionAtom);
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (lastSeen !== BUILD_VERSION) {
      const timer = setTimeout(() => setLastSeen(BUILD_VERSION), 2000);
      return () => clearTimeout(timer);
    }
  }, [lastSeen, setLastSeen]);

  return null;
}
