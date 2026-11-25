import {
  isTerminalEvent,
  isTerminalInfo,
  MAX_TERMINAL_FRAME_LENGTH,
  type Placement,
  type TerminalControl,
} from "@dispatch/runner-protocol";
import { wireFrames } from "../runners/enrolled/v1-framing.js";
import type { RemoteRunnerService } from "../agents/remote/service.js";
import { TERMINAL_UPDATE_MESSAGE } from "@dispatch/runner-protocol";
import { typedTerminal } from "./typed.js";
import type { TerminalBackend } from "./manager.js";

export function remoteTerminal(
  runner: Pick<RemoteRunnerService, "requestSession"> &
    Partial<Pick<RemoteRunnerService, "streamTerminal">>,
  placement: Placement,
  agentId: string
): TerminalBackend {
  return async (output, inputFull) => {
    const streamed = runner.streamTerminal?.(placement, agentId, {
      cols: 80,
      rows: 24,
    });
    if (streamed) return typedTerminal(() => streamed)(output, inputFull);

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
      let endReason: string | undefined;
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
              endReason = TERMINAL_UPDATE_MESSAGE;
            finish(event.type === "exit" ? event.code : null);
            channel.destroy();
          }
        },
        MAX_TERMINAL_FRAME_LENGTH
      );
      return {
        ...info,
        exited,
        endReason: () => endReason,
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
