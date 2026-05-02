import { TmuxTerminal } from "./tmux-terminal.js";

export type TerminalCopyMode = "live" | "copy" | "exiting";

export type TerminalUiState = {
  copyMode: TerminalCopyMode;
  lastObservedAt: number;
};

type InteractionType = "scroll" | "exit_copy_mode";

type PublishTerminalState = (event: {
  type: "agent.terminal_state_changed";
  agentId: string;
  terminalState: TerminalUiState;
}) => void;

type SessionObserver = {
  agentId: string;
  sessionName: string;
  terminal: TmuxTerminal;
  viewers: Set<string>;
  state: TerminalUiState;
  lastPublishedKey: string | null;
  boostedUntil: number;
  exitPendingUntil: number;
  cleanupTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  pollInFlight: Promise<void> | null;
};

const STABLE_POLL_MS = 1_250;
const ACTIVE_POLL_MS = 250;
const INTERACTION_BOOST_MS = 1_500;
const EXIT_PENDING_MS = 2_000;
const DETACH_GRACE_MS = 2_000;

export class CopyModeObserverManager {
  private readonly observers = new Map<string, SessionObserver>();

  constructor(private readonly publishTerminalState: PublishTerminalState) {}

  attachViewer(
    agentId: string,
    sessionName: string,
    viewerId: string
  ): () => void {
    const observer = this.getOrCreateObserver(agentId, sessionName);
    if (observer.cleanupTimer) {
      clearTimeout(observer.cleanupTimer);
      observer.cleanupTimer = null;
    }
    observer.viewers.add(viewerId);
    this.requestImmediatePoll(observer);

    return () => {
      const current = this.observers.get(sessionName);
      if (!current) return;
      current.viewers.delete(viewerId);
      if (current.viewers.size === 0) {
        if (current.pollTimer) {
          clearTimeout(current.pollTimer);
          current.pollTimer = null;
        }
        this.scheduleObserverCleanup(current);
      }
    };
  }

  async getState(
    agentId: string,
    sessionName: string
  ): Promise<TerminalUiState> {
    const observer = this.getOrCreateObserver(agentId, sessionName);
    await this.poll(observer);
    this.scheduleObserverCleanup(observer);
    return observer.state;
  }

  noteInteraction(
    agentId: string,
    sessionName: string,
    interaction: InteractionType
  ): void {
    const observer = this.getOrCreateObserver(agentId, sessionName);
    const now = Date.now();
    if (interaction === "scroll") {
      observer.boostedUntil = Math.max(
        observer.boostedUntil,
        now + INTERACTION_BOOST_MS
      );
    } else {
      observer.boostedUntil = Math.max(
        observer.boostedUntil,
        now + EXIT_PENDING_MS
      );
      observer.exitPendingUntil = Math.max(
        observer.exitPendingUntil,
        now + EXIT_PENDING_MS
      );
      this.updateState(observer, {
        copyMode: "exiting",
        lastObservedAt: observer.state.lastObservedAt || now,
      });
    }

    if (observer.viewers.size > 0) {
      this.requestImmediatePoll(observer);
      return;
    }

    this.scheduleObserverCleanup(observer);
  }

  private getOrCreateObserver(
    agentId: string,
    sessionName: string
  ): SessionObserver {
    const existing = this.observers.get(sessionName);
    if (existing) {
      existing.agentId = agentId;
      return existing;
    }

    const observer: SessionObserver = {
      agentId,
      sessionName,
      terminal: new TmuxTerminal(sessionName),
      viewers: new Set(),
      state: {
        copyMode: "live",
        lastObservedAt: 0,
      },
      lastPublishedKey: null,
      boostedUntil: 0,
      exitPendingUntil: 0,
      cleanupTimer: null,
      pollTimer: null,
      pollInFlight: null,
    };
    this.observers.set(sessionName, observer);
    return observer;
  }

  private requestImmediatePoll(observer: SessionObserver): void {
    if (observer.pollTimer) {
      clearTimeout(observer.pollTimer);
      observer.pollTimer = null;
    }
    void this.poll(observer);
  }

  private scheduleObserverCleanup(observer: SessionObserver): void {
    if (observer.viewers.size > 0) {
      return;
    }

    if (observer.cleanupTimer) {
      clearTimeout(observer.cleanupTimer);
    }

    observer.cleanupTimer = setTimeout(() => {
      const latest = this.observers.get(observer.sessionName);
      if (!latest || latest.viewers.size > 0) {
        return;
      }
      latest.cleanupTimer = null;
      latest.boostedUntil = 0;
      latest.exitPendingUntil = 0;
      if (latest.pollTimer) {
        clearTimeout(latest.pollTimer);
        latest.pollTimer = null;
      }
      this.observers.delete(observer.sessionName);
    }, DETACH_GRACE_MS);
  }

  private scheduleNextPoll(observer: SessionObserver): void {
    if (observer.viewers.size === 0) {
      if (observer.pollTimer) {
        clearTimeout(observer.pollTimer);
        observer.pollTimer = null;
      }
      return;
    }

    if (observer.pollTimer) {
      clearTimeout(observer.pollTimer);
    }

    const now = Date.now();
    const shouldPollFast =
      observer.state.copyMode !== "live" || observer.boostedUntil > now;
    observer.pollTimer = setTimeout(
      () => {
        observer.pollTimer = null;
        void this.poll(observer);
      },
      shouldPollFast ? ACTIVE_POLL_MS : STABLE_POLL_MS
    );
  }

  private async poll(observer: SessionObserver): Promise<void> {
    if (observer.pollInFlight) {
      await observer.pollInFlight;
      return;
    }

    observer.pollInFlight = (async () => {
      const observedAt = Date.now();
      const state = await observer.terminal.getCopyModeState();
      const now = Date.now();

      if (!state.inCopyMode) {
        observer.exitPendingUntil = 0;
        this.updateState(observer, {
          copyMode: "live",
          lastObservedAt: observedAt,
        });
      } else if (observer.exitPendingUntil > now) {
        this.updateState(observer, {
          copyMode: "exiting",
          lastObservedAt: observedAt,
        });
      } else {
        observer.exitPendingUntil = 0;
        this.updateState(observer, {
          copyMode: "copy",
          lastObservedAt: observedAt,
        });
      }
    })();

    try {
      await observer.pollInFlight;
    } finally {
      observer.pollInFlight = null;
      this.scheduleNextPoll(observer);
    }
  }

  private updateState(
    observer: SessionObserver,
    nextState: TerminalUiState
  ): void {
    observer.state = nextState;
    const nextKey = nextState.copyMode;
    if (nextKey === observer.lastPublishedKey) {
      return;
    }
    observer.lastPublishedKey = nextKey;
    this.publishTerminalState({
      type: "agent.terminal_state_changed",
      agentId: observer.agentId,
      terminalState: nextState,
    });
  }
}
