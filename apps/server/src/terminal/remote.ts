import {
  isTerminalEvent,
  isTerminalInfo,
  MAX_TERMINAL_FRAME_LENGTH,
  type Placement,
  type TerminalControl,
} from "@dispatch/runner-protocol";
import { wireFrames } from "@dispatch/runner-protocol/node";
import type { RemoteRunnerService } from "../agents/remote/service.js";
import type { TerminalBackend } from "./manager.js";

/** Shown in the terminal when the runner closes it for a supervisor update. */
export const RUNNER_UPDATE_TERMINAL_NOTICE =
  "\r\n[Runner updating: this terminal was closed. Reopen it after the update.]\r\n";

export function remoteTerminal(
  runner: Pick<RemoteRunnerService, "requestSession">,
  placement: Placement,
  agentId: string
): TerminalBackend {
  return async (output) => {
    const { value, channel } = await runner.requestSession(placement, {
      kind: "openTerminal",
      agentId,
    });
    try {
      const info: unknown =
        typeof value === "string" ? JSON.parse(value) : null;
      if (!channel || !isTerminalInfo(info))
        throw new Error("Invalid runner terminal response.");
      let finish!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => {
        finish = resolve;
      });
      channel.once("close", () => finish(null));
      channel.once("end", () => finish(null));
      const send = wireFrames<unknown, TerminalControl>(
        channel,
        (event) => {
          if (!isTerminalEvent(event)) return channel.destroy();
          if (event.type === "output")
            output(Buffer.from(event.data, "base64"));
          else {
            if (event.type === "error" && event.reason === "update")
              output(Buffer.from(RUNNER_UPDATE_TERMINAL_NOTICE));
            finish(event.type === "exit" ? event.code : null);
            channel.destroy();
          }
        },
        MAX_TERMINAL_FRAME_LENGTH
      );
      return {
        ...info,
        exited,
        kill: () => channel.destroy(),
        terminal: {
          write(data) {
            send({ type: "input", data });
            return Buffer.byteLength(data);
          },
          resize: (cols, rows) => send({ type: "resize", cols, rows }),
          close: () => channel.destroy(),
          detach: () => send({ type: "detach" }),
          resume: () => send({ type: "resume" }),
        },
      };
    } catch (error) {
      channel?.destroy();
      throw error;
    }
  };
}
