import type { HarnessAuthStatus } from "@dispatch/shared";
import {
  CircleHelp,
  KeyRound,
  LogOut,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";

import { cn } from "@/lib/utils";

export function AuthStatusBadge({
  auth,
  compact = false,
  className,
}: {
  auth: HarnessAuthStatus;
  compact?: boolean;
  className?: string;
}): JSX.Element {
  const Icon =
    auth.kind === "api_key"
      ? KeyRound
      : auth.kind === "subscription"
        ? ShieldCheck
        : auth.kind === "oauth"
          ? UserRoundCheck
          : auth.kind === "not_signed_in"
            ? LogOut
            : CircleHelp;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-muted-foreground",
        className
      )}
      title={auth.detail ?? auth.label}
      data-testid={`harness-auth-${auth.engineId}`}
      data-auth-kind={auth.kind}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className={cn(compact && "truncate")}>{auth.label}</span>
    </span>
  );
}
