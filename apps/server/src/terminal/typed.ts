import type { CallerChannel, Res } from "@dispatch/runner-protocol/contract";
import { TERMINAL_UPDATE_MESSAGE } from "../agents/remote/update-admission.js";
import type { TerminalBackend } from "./manager.js";

const TERMINAL_INPUT_FULL = "Terminal input buffer full.";

export function typedTerminal(
  open: () => Promise<{
    info: Res<"terminal.open">;
    channel: CallerChannel<"terminal.open">;
  }>
): TerminalBackend {
  return async (output, inputFull) => {
    const { info, channel } = await open();
    let finish!: (code: number | null) => void;
    let endReason: string | undefined;
    const exited = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    channel.onClose((error) => {
      if (error?.code === "fenced") endReason = TERMINAL_UPDATE_MESSAGE;
      finish(null);
    });
    channel.onData((event) => {
      if (event.type === "output") {
        output(Buffer.from(event.data, "base64"));
      } else if (event.type === "exit") {
        finish(event.code);
      } else if (event.type === "error" && event.reason === "update") {
        endReason = TERMINAL_UPDATE_MESSAGE;
        finish(null);
      } else if (
        event.type === "error" &&
        event.message === TERMINAL_INPUT_FULL
      ) {
        inputFull();
      } else {
        finish(null);
      }
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      channel.close();
    };
    return {
      ...info,
      exited,
      endReason: () => endReason,
      kill: close,
      terminal: {
        write(data) {
          channel.write({ type: "input", data });
          return Buffer.byteLength(data);
        },
        resize: (cols, rows) => channel.write({ type: "resize", cols, rows }),
        close,
      },
    };
  };
}
