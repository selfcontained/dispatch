import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import { BUILD_VERSION } from "@/lib/version";

import { getTipById } from "./tips";
import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "./tips-state";
import { isVersionNewer } from "./version-compare";

export function useTip(id: string) {
  const tip = useMemo(() => getTipById(id) ?? null, [id]);
  const enabled = useAtomValue(tipsEnabledAtom);
  const [dismissed, setDismissed] = useAtom(dismissedTipsAtom);
  const setEnabled = useSetAtom(tipsEnabledAtom);
  const lastSeenVersion = useAtomValue(lastSeenVersionAtom);

  const isDismissed = dismissed.includes(id);
  const isInReleaseWindow =
    tip !== null && lastSeenVersion !== null
      ? isVersionNewer(BUILD_VERSION, tip.since) &&
        !isVersionNewer(lastSeenVersion, tip.since)
      : false;

  const shouldShowInline =
    tip !== null &&
    enabled &&
    !isDismissed &&
    tip.surfaces.includes("inline") &&
    isInReleaseWindow;

  const shouldShowAmbient =
    tip !== null && enabled && !isDismissed && tip.surfaces.includes("ambient");

  const dismiss = useCallback(() => {
    setDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [id, setDismissed]);

  const disableAll = useCallback(() => {
    setEnabled(false);
  }, [setEnabled]);

  return { tip, shouldShowInline, shouldShowAmbient, dismiss, disableAll };
}
