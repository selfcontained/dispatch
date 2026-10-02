import { randomUUID } from "node:crypto";
import type {
  MacAppUpdateAction,
  MacAppUpdateSnapshot,
  MacAppUpdateState,
} from "@dispatch/shared";

import type { PublishUiEvent } from "./server/ui-events.js";

type ControlStream = Pick<NodeJS.WritableStream, "write" | "end">;

/**
 * Relays update commands from the web app to the macOS menu app, and the menu
 * app's update state back. The menu app holds one SSE control connection;
 * a newer connection replaces the older one (the app reconnected or relaunched).
 */
export class MacAppUpdateBridge {
  private control: ControlStream | null = null;
  private state: MacAppUpdateState | null = null;

  constructor(private readonly publish: PublishUiEvent) {}

  snapshot(): MacAppUpdateSnapshot {
    return { connected: this.control !== null, state: this.state };
  }

  /** Returns the detach callback for the stream's close event. */
  attach(stream: ControlStream): () => void {
    const previous = this.control;
    this.control = stream;
    previous?.end();
    this.changed();
    return () => {
      if (this.control !== stream) return;
      this.control = null;
      this.state = null;
      this.changed();
    };
  }

  /** State only counts while a control connection is open; false otherwise. */
  report(state: MacAppUpdateState): boolean {
    if (!this.control) return false;
    this.state = state;
    this.changed();
    return true;
  }

  /** False when no menu app is connected to receive the command. */
  send(action: MacAppUpdateAction): boolean {
    if (!this.control) return false;
    const command = { type: "command", id: randomUUID(), action };
    this.control.write(`data: ${JSON.stringify(command)}\n\n`);
    return true;
  }

  private changed(): void {
    this.publish({ type: "mac_app.update_changed", update: this.snapshot() });
  }
}
