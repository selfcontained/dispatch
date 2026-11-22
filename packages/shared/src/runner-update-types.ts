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
  };
  /** Agents still on the previous build after a confirmed update. */
  previousBuildAgents?: number;
};
