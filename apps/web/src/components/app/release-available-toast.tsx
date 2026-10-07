import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { ArrowDownToLine } from "lucide-react";
import { toast } from "sonner";

import { useCachedReleaseInfo } from "@/hooks/use-cached-release-info";
import { dismissedReleaseToastAtomFamily } from "@/lib/store";
import { api } from "@/lib/api";

const TOAST_ID_PREFIX = "release-available-";

/**
 * Subscribes to the cached release-info snapshot and surfaces any unseen
 * "update available" event as a sticky sonner toast. Returns no JSX —
 * the global <Toaster /> handles render. Mounted once at the app root.
 *
 * Dismissal is per-tag: clicking "Later" sets a localStorage flag for
 * that exact tag, so a newer release still surfaces a fresh toast.
 *
 * Naming: distinct from the older UpdateAvailableToast, which fires when
 * the running tab detects the *server* has a newer version than the page
 * was loaded against (a separate stale-tab signal, not a release
 * discovery).
 */
export function ReleaseAvailableToast(): null {
  const navigate = useNavigate();
  const { data } = useCachedReleaseInfo();
  const snapshot = data?.snapshot ?? null;
  const tag = snapshot?.updateAvailable ? snapshot.latestTag : null;
  const dismissedAtom = dismissedReleaseToastAtomFamily(tag ?? "__none__");
  const dismissed = useAtomValue(dismissedAtom);
  const setDismissed = useSetAtom(dismissedAtom);

  // Track the tag of the toast that's currently visible on screen so we
  // can dismiss it explicitly when the snapshot transitions out of the
  // "show" state — instead of via effect cleanup, which would dismiss
  // and recreate on every dep change and produce a visible flicker.
  const shownTagRef = useRef<string | null>(null);

  useEffect(() => {
    const wantsToShow =
      snapshot !== null &&
      snapshot.updateAvailable &&
      tag !== null &&
      !dismissed;

    // Tag changed (or we no longer want to show): retire the prior toast.
    const prevTag = shownTagRef.current;
    if (prevTag !== null && prevTag !== tag) {
      toast.dismiss(`${TOAST_ID_PREFIX}${prevTag}`);
      shownTagRef.current = null;
    }

    if (!wantsToShow) {
      // Conditions no longer met for the *current* tag (e.g. user
      // dismissed, or updateAvailable flipped to false). Make sure
      // anything we previously rendered is gone.
      if (prevTag !== null && prevTag === tag) {
        toast.dismiss(`${TOAST_ID_PREFIX}${tag}`);
        shownTagRef.current = null;
      }
      return;
    }

    const toastId = `${TOAST_ID_PREFIX}${tag}`;

    // Sonner dedupes by id — calling toast.info again with the same id
    // updates the existing toast in place rather than creating a new
    // one, so re-renders don't flicker.
    toast.info(`Dispatch ${tag} is available`, {
      id: toastId,
      duration: Infinity,
      icon: <ArrowDownToLine className="h-4 w-4" />,
      action: {
        label: "Update now",
        onClick: async () => {
          // Await the apply-start request so a 5xx / network failure
          // surfaces as an error toast rather than vanishing silently
          // alongside the dismissal of this one. On success the operator
          // lands on /settings/updates to watch the takeover.
          try {
            await api("/api/v1/release/update", {
              method: "POST",
              body: JSON.stringify({ tag }),
            });
          } catch (err) {
            toast.error(
              err instanceof Error
                ? `Couldn't start update: ${err.message}`
                : "Couldn't start update"
            );
            return;
          }
          navigate("/settings/updates");
        },
      },
      cancel: {
        label: "Later",
        onClick: () => {
          setDismissed(true);
        },
      },
      // Intentionally no `onDismiss` callback. Sonner fires it for BOTH
      // user-initiated dismissals AND programmatic `toast.dismiss(id)`,
      // so wiring it to setDismissed would treat every transition as a
      // user dismissal. The cancel button above is the canonical
      // "user said Later" signal.
    });

    shownTagRef.current = tag;

    // No effect-cleanup dismissal — transitions are handled at the top of
    // the next effect run via shownTagRef. This avoids the
    // dismiss-and-recreate flicker that happens when React Query produces
    // a new snapshot reference with identical content.
  }, [snapshot, tag, dismissed, navigate, setDismissed]);

  return null;
}
