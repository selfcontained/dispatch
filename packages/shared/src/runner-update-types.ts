export type RunnerUpdateAction = "update" | "retry";

export type RunnerUpdatePhaseView =
  | "staging"
  | "settling"
  | "draining"
  /** Update now: turns are being interrupted and hosts stopped. */
  | "interrupting"
  | "resuming"
  | "switching"
  | "confirming"
  | "cancelling";

export type RunnerUpdateResultState =
  | "updated"
  | "rolled_back"
  | "deferred"
  /** The new build cannot adopt the running agents' hosts. */
  | "needs_idle";

/** Every reason an update can end with. */
export const RUNNER_UPDATE_RESULT_REASONS = [
  // An operator ended the wait, or let it run out.
  "drain_cancelled",
  "automatic_drain_cancelled",
  "drain_timeout",
  // The build was refused.
  "verify_failed",
  "downgrade",
  "suppressed",
  // The update was no longer wanted, or there was nothing to update.
  "automatic_disabled",
  "dispatch_changed",
  "runner_newer",
  "revoked",
  // It didn't finish.
  "attach_unavailable",
  "boot_failed",
  "cancelled",
  "confirm_timeout",
  "download_failed",
  "force_timeout",
  "hold_lost",
  "identity_mismatch",
  "incompatible_handoff",
  "interrupted",
  "no_response",
  "operations_pending",
  "reattach_failed",
  "settle_timeout",
  "staging_timeout",
  "state_unsaved",
  "switch_timeout",
  "trial_interrupted",
  "unsupported",
] as const;
export type RunnerUpdateResultReason =
  (typeof RUNNER_UPDATE_RESULT_REASONS)[number];

/** A runner's controller-driven update, as the runner list reports it. */
export type RunnerUpdateView = {
  /** An update Dispatch can run now, and the action that starts it. */
  available?: { version: string; action: RunnerUpdateAction };
  attempt?: {
    id: string;
    phase: RunnerUpdatePhaseView;
    version?: string;
    agents?: number;
    /** New work for the runner waits: from staged until the attempt ends. */
    held?: boolean;
  };
  result?: {
    state: RunnerUpdateResultState;
    version?: string;
    /** A stable code; the client words it. */
    reason?: string;
    /** The runner's version floor, with reason `downgrade`. */
    floorVersion?: string;
    /** Automatic updates leave this build until an operator's Update. */
    automaticSkipped?: true;
  };
  /** Agents still on the previous build after a confirmed update. */
  previousBuildAgents?: number;
};
