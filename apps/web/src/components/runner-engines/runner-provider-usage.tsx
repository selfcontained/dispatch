import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { createClientId } from "@/lib/client-id";
import { Button } from "@/components/ui/button";
import {
  runnerEngineCapability,
  useRunnerProviderUsage,
} from "@/hooks/use-runner-engines";

export function RunnerProviderUsage({
  runnerId,
  allowReset = false,
}: {
  runnerId: string;
  allowReset?: boolean;
}) {
  const usage = useRunnerProviderUsage(runnerId, true);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const redeem = useMutation({
    mutationFn: (account: string) =>
      runnerEngineCapability(
        runnerId,
        { type: "codex_reset", account, requestId: createClientId() },
        "codex_reset"
      ),
    onSettled: () => usage.refetch(),
  });
  const report = usage.data;
  const account = report?.codexResetAccount;
  const resetCount =
    report?.providers.find((plan) => plan.engine === "codex")?.limitResets
      ?.available ?? 0;
  const canRedeem =
    allowReset &&
    account &&
    resetCount > 0 &&
    !usage.isFetching &&
    !usage.isError &&
    !redeem.isPending;

  return (
    <section aria-label="Runner plan limits" className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">Plan limits</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={usage.isFetching || redeem.isPending}
          onClick={() => void usage.refetch()}
        >
          Refresh usage
        </Button>
      </div>
      {usage.isPending && <p role="status">Reading runner usage…</p>}
      {usage.isError && (
        <p role="status">
          {report
            ? "Showing the last report. Refresh failed."
            : usage.error.message}
        </p>
      )}
      {report?.providers.map((plan) => (
        <div key={plan.engine} className="space-y-1">
          <p className="font-medium">
            {plan.engine === "codex" ? "Codex" : "Claude"}
            {plan.plan && ` · ${plan.plan}`}
          </p>
          {plan.unavailableReason && (
            <p className="text-muted-foreground">{plan.unavailableReason}</p>
          )}
          {plan.windows.map((window) => (
            <p key={window.id}>
              {window.label} · {Math.round(100 - window.usedPercent)}% remaining
              {window.resetsAt &&
                ` · resets ${new Date(window.resetsAt).toLocaleString()}`}
            </p>
          ))}
          {plan.spend && (
            <p>
              {plan.spend.used} of {plan.spend.limit} {plan.spend.currency} used
            </p>
          )}
          {plan.credits && (
            <p>
              {plan.credits.unlimited
                ? "Unlimited credits"
                : `Credit balance ${plan.credits.balance ?? "unknown"}`}
            </p>
          )}
          {plan.observedAt && (
            <p className="text-muted-foreground">
              Observed {new Date(plan.observedAt).toLocaleString()}
            </p>
          )}
        </div>
      ))}
      {resetCount > 0 && (
        <p>
          {resetCount} Codex reset {resetCount === 1 ? "credit" : "credits"}{" "}
          available
        </p>
      )}
      {allowReset && (
        <AlertDialog
          onOpenChange={(open) =>
            setConfirmation(open ? (account ?? null) : null)
          }
        >
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={!canRedeem}
            >
              Use Codex reset credit
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Use a Codex reset credit?</AlertDialogTitle>
            <AlertDialogDescription>
              This spends one credit on the Codex account shown for this runner
              if its limits can be reset.
            </AlertDialogDescription>
            <div className="flex flex-wrap justify-end gap-2">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  !canRedeem || !confirmation || confirmation !== account
                }
                onClick={() => confirmation && redeem.mutate(confirmation)}
              >
                Use reset credit
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {redeem.isError && <p role="alert">{redeem.error.message}</p>}
      {redeem.data && (
        <p role="status">
          {redeem.data.code === "ok"
            ? "Codex reset applied."
            : redeem.data.code === "nothing_to_reset"
              ? "Codex has no windows to reset."
              : redeem.data.code === "no_credit"
                ? "Codex has no reset credit available."
                : "Codex did not confirm the reset. Check usage before trying again."}
        </p>
      )}
    </section>
  );
}
