import { MANAGED_WORKSPACE } from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionToWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import type { CallHandlers } from "../../../handlers.js";
import type { createSessionSupervisor } from "./session-supervisor.js";

type Op = "workspace.prepare" | "workspace.resume" | "workspace.release";
export type WorkspacePreparationPort = {
  call<K extends Op>(
    op: K,
    input: Req<K>,
    emit: (event: unknown) => void
  ): Promise<Res<K>>;
};
type Supervisor = Pick<
  Awaited<ReturnType<typeof createSessionSupervisor>>,
  "withWorkspacePreparation" | "releaseWorkspace"
>;

export function enrolledWorkspace(
  supervisor: Supervisor,
  preparation: WorkspacePreparationPort | undefined,
  closeTerminals: (session: string) => void
) {
  function port() {
    if (!preparation)
      throw new RunnerCallError({
        code: "unsupported",
        message: "This runner does not serve workspace preparation.",
      });
    return preparation;
  }
  return {
    "workspace.prepare": async (input, { emit }) => {
      const id = sessionToWire(input.session);
      const result = await supervisor.withWorkspacePreparation(
        id,
        true,
        () => port().call("workspace.prepare", input, emit),
        "session" in input.source
          ? sessionToWire(input.source.session)
          : undefined
      );
      // A discarded session rejects a preparation under this same lock.
      if (!result)
        throw new RunnerCallError({
          code: "conflict",
          message: "This runner session was discarded.",
        });
      return result;
    },
    "workspace.resume": async (input, { emit }) => {
      try {
        return await supervisor.withWorkspacePreparation(
          sessionToWire(input.session),
          false,
          () => port().call("workspace.resume", input, emit)
        );
      } catch (error) {
        if (error instanceof RunnerCallError && error.code === "forbidden")
          throw new RunnerCallError({
            code: "conflict",
            message: error.message,
            details: error.details,
          });
        throw error;
      }
    },
    "workspace.release": async (input) => {
      const id = sessionToWire(input.session);
      const removed = await supervisor.releaseWorkspace(
        id,
        MANAGED_WORKSPACE,
        async () =>
          (await port().call("workspace.release", input, () => {})).removed
      );
      if (removed) closeTerminals(id);
      return { removed };
    },
  } satisfies CallHandlers;
}
