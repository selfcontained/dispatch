/*
 * Persona authoring's view of an agent's checkout: reads, listings and one
 * guarded write, all through the agent's own runner, the same for every
 * agent. The runner decides where the checkout is and writes as its
 * workload; Dispatch only parses.
 */
import type { Runner } from "@dispatch/runner-protocol/contract";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import { sessionRunner, target } from "../agents/checkout-runner.js";
import type { PersonaFiles } from "./authoring.js";

/** A runner adapter that can say it does not serve an operation (a v1 peer without the flag). */
type MaybeServes = Runner & { serves?: (op: "checkout.write") => boolean };

export function sessionPersonaFiles(
  manager: Pick<AgentManager, "inspectCheckout" | "checkoutReadRunners">,
  agent: AgentRecord
): { files: PersonaFiles; writes: boolean } {
  const runner = sessionRunner(
    manager.checkoutReadRunners(),
    agent
  ) as MaybeServes;
  const files: PersonaFiles = {
    async read(path) {
      const file = await runner.call("checkout.read", {
        target: target(agent),
        path,
        encoding: "utf8",
        maxBytes: null,
      });
      if (file === null) return null;
      if (file.digest === undefined)
        throw new Error("The runner did not report the file's digest.");
      return { data: file.data, digest: file.digest };
    },
    async list(directory) {
      const reply = await manager.inspectCheckout(agent, {
        kind: "listFiles",
        path: directory,
      });
      if (reply.kind !== "listFiles")
        throw new Error("Runner did not return a file list.");
      return reply.names;
    },
    async write(path, data, expectedDigest) {
      await runner.call("checkout.write", {
        target: target(agent),
        path,
        data,
        expectedDigest,
      });
    },
  };
  return { files, writes: runner.serves?.("checkout.write") ?? true };
}
