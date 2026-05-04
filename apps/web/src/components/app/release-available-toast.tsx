import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { ArrowDownToLine, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import {
  useCachedReleaseInfo,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";
import { dismissedReleaseToastAtomFamily } from "@/lib/store";
import { api } from "@/lib/api";

const TOAST_ID_PREFIX = "release-available-";

type Variant = "standard" | "recommended" | "required";

function classifyVariant(snapshot: ReleaseInfoSnapshot): Variant {
  // "required" wins over "recommended" so the stronger framing reaches the
  // operator when both signals are present (e.g. mode=recommended plus an
  // unrelated migration evaluation error).
  if (
    snapshot.assistedRequired ||
    (snapshot.pendingMigrations?.length ?? 0) > 0 ||
    snapshot.assisted?.mode === "required" ||
    snapshot.migrationsError
  ) {
    return "required";
  }
  if (snapshot.assisted?.mode === "recommended") {
    return "recommended";
  }
  return "standard";
}

function copyForVariant(
  variant: Variant,
  tag: string
): { title: string; primaryLabel: string; secondaryLabel: string } {
  if (variant === "required") {
    return {
      title: `Dispatch ${tag} needs guided update steps`,
      primaryLabel: "Review update",
      secondaryLabel: "Later",
    };
  }
  if (variant === "recommended") {
    return {
      title: `Dispatch ${tag} is available — guided update recommended`,
      primaryLabel: "Review update",
      secondaryLabel: "Later",
    };
  }
  return {
    title: `Dispatch ${tag} is available`,
    primaryLabel: "Update now",
    secondaryLabel: "Later",
  };
}

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

  useEffect(() => {
    if (!snapshot || !snapshot.updateAvailable || !tag) return;
    if (dismissed) return;

    const variant = classifyVariant(snapshot);
    const { title, primaryLabel, secondaryLabel } = copyForVariant(
      variant,
      tag
    );
    const toastId = `${TOAST_ID_PREFIX}${tag}`;

    toast(title, {
      id: toastId,
      duration: Infinity,
      icon:
        variant === "required" ? (
          <ShieldAlert className="h-4 w-4" />
        ) : (
          <ArrowDownToLine className="h-4 w-4" />
        ),
      action: {
        label: primaryLabel,
        onClick: () => {
          if (variant === "standard") {
            void api("/api/v1/release/update", {
              method: "POST",
              body: JSON.stringify({ tag }),
            }).catch(() => {});
          }
          // Both standard and assisted variants land on the Updates page —
          // standard so the operator can watch the apply-flow takeover,
          // assisted so they review the migration list before launching
          // the agent. Per spec, "Review update" must NOT auto-launch.
          navigate("/settings/updates");
        },
      },
      cancel: {
        label: secondaryLabel,
        onClick: () => {
          setDismissed(true);
        },
      },
      onDismiss: () => {
        setDismissed(true);
      },
    });

    return () => {
      toast.dismiss(toastId);
    };
  }, [snapshot, tag, dismissed, navigate, setDismissed]);

  return null;
}
