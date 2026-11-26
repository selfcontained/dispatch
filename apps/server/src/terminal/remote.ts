import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import type { RemoteRunnerService } from "../agents/remote/service.js";
import { typedTerminal } from "./typed.js";
import type { TerminalBackend } from "./manager.js";

export function remoteTerminal(
  runner: Pick<RemoteRunnerService, "open">,
  runnerId: string,
  agentId: string
): TerminalBackend {
  return typedTerminal(() =>
    runner.open(runnerId, "terminal.open", {
      target: { session: sessionFromWire(agentId) },
      cols: 80,
      rows: 24,
    })
  );
}
