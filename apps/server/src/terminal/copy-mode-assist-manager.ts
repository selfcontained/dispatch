import { randomUUID } from "node:crypto";

import { TmuxTerminal } from "./tmux-terminal.js";

type ActiveAssistSession = {
  connections: Set<string>;
  originalMouseMode: "on" | "off" | null;
};

type ActiveAssistConnection = {
  activeRef: { current: boolean };
  deactivate: () => void;
  sessionName: string;
};

export class CopyModeAssistManager {
  private readonly sessions = new Map<string, ActiveAssistSession>();
  private readonly connections = new Map<string, ActiveAssistConnection>();

  async attach(
    sessionName: string,
    deactivate: () => void
  ): Promise<{ activeRef: { current: boolean }; connectionId: string }> {
    const connectionId = randomUUID();
    const activeRef = { current: true };
    let session = this.sessions.get(sessionName);

    if (!session) {
      const terminal = new TmuxTerminal(sessionName);
      const originalMouseMode = await terminal.getMouseMode();
      try {
        await terminal.setMouseMode("on");
      } catch {
        // ignore — tmux may have raced with shutdown
      }

      session = {
        connections: new Set(),
        originalMouseMode,
      };
      this.sessions.set(sessionName, session);
    }

    session.connections.add(connectionId);
    this.connections.set(connectionId, {
      activeRef,
      deactivate,
      sessionName,
    });

    return { activeRef, connectionId };
  }

  async detach(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    this.connections.delete(connectionId);
    connection.activeRef.current = false;
    connection.deactivate();

    const session = this.sessions.get(connection.sessionName);
    if (!session) return;

    session.connections.delete(connectionId);
    if (session.connections.size > 0) return;

    this.sessions.delete(connection.sessionName);
    try {
      const terminal = new TmuxTerminal(connection.sessionName);
      await terminal.setMouseMode(session.originalMouseMode ?? "off");
    } catch {
      // ignore — tmux may have raced with shutdown
    }
  }

  async disableAll(): Promise<void> {
    const connectionIds = [...this.connections.keys()];
    await Promise.all(connectionIds.map((id) => this.detach(id)));
  }
}
