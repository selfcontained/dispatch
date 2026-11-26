import { once } from "node:events";
import { MANAGED_WORKSPACE } from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  pathFromWire,
  displayPath,
  sessionToWire,
} from "@dispatch/runner-protocol/contract";
import {
  decodeSessionFrame,
  mapIncomingFrames,
} from "@dispatch/runner-client/v1/host";
import type { Handlers } from "../../../handlers.js";
import type { createSessionSupervisor } from "./session-supervisor.js";

type Supervisor = Awaited<ReturnType<typeof createSessionSupervisor>>;

export function enrolledSessions(
  supervisor: Supervisor,
  closeTerminals: (id: string) => void
) {
  const workspace = MANAGED_WORKSPACE;
  return {
    calls: {
      "session.launch": (request) => supervisor.launchSession(request),
      "session.alive": async ({ session }) => ({
        state: (await supervisor.alive(sessionToWire(session), workspace))
          ? "live"
          : "gone",
      }),
      "session.list": ({ owner }) => supervisor.listSessions(workspace, owner),
      "session.sample": ({ sessions }) =>
        supervisor.sampleSessions(workspace, sessions),
      "session.logs": async ({ session }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id, workspace)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return { text: await supervisor.log(id, workspace) };
      },
      "session.stop": async ({
        session,
        force,
        expectedLaunchId,
        expectedOwner,
        idleOnly,
      }) => {
        const id = sessionToWire(session);
        const stopped = await supervisor.stop(
          id,
          workspace,
          force,
          expectedLaunchId,
          expectedOwner,
          idleOnly
        );
        if (stopped !== false) closeTerminals(id);
        return {};
      },
      "session.discard": async ({ session }) => {
        const id = sessionToWire(session);
        await supervisor.discard(id, workspace);
        closeTerminals(id);
        return {};
      },
      "workspace.observe": async ({ session, policy }) => {
        const observation = await supervisor.observeWorkspace(
          sessionToWire(session),
          workspace,
          policy ?? "changes"
        );
        const checkout = observation.checkout;
        return {
          ...observation,
          checkout: checkout && {
            ...checkout,
            path: pathFromWire(checkout.path),
          },
        };
      },
      "git.context": async ({ target }) => {
        if (!("session" in target))
          throw new RunnerCallError({
            code: "invalid",
            message: "Invalid checkout read binding.",
          });
        return supervisor.gitContext(sessionToWire(target.session), workspace, {
          kind: "context",
          checkout: target.checkout,
        });
      },
      "workspace.describe": async ({ session }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id, workspace)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return binding(
          await supervisor.sessionCheckout(id, workspace, { kind: "describe" })
        );
      },
      "workspace.select": async ({ session, path }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id, workspace)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return binding(
          await supervisor.sessionCheckout(id, workspace, {
            kind: "select",
            path: path === null ? null : displayPath(path),
          })
        );
      },
    },
    opens: {
      "session.attach": async ({ session }) => {
        const id = sessionToWire(session);
        const socket =
          (await supervisor.isBound(id, workspace)) &&
          (await supervisor.attach(id, workspace));
        if (!socket)
          throw new RunnerCallError({
            code: "host_gone",
            message: "Guest agent host has exited.",
          });
        if (socket.connecting) await once(socket, "connect");
        return {
          info: {},
          channel: mapIncomingFrames(socket, (frame) =>
            decodeSessionFrame(frame, id)
          ),
        };
      },
    },
  } satisfies Handlers;
}

function binding(value: Awaited<ReturnType<Supervisor["sessionCheckout"]>>) {
  const { path, repositoryRoot, checkoutRoot, ...rest } = value;
  return {
    ...rest,
    path: pathFromWire(path),
    repositoryRoot:
      repositoryRoot == null ? repositoryRoot : pathFromWire(repositoryRoot),
    checkoutRoot:
      checkoutRoot == null ? checkoutRoot : pathFromWire(checkoutRoot),
  };
}
