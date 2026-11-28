import { once } from "node:events";
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
  return {
    calls: {
      "session.launch": (request) => supervisor.launchSession(request),
      "session.alive": async ({ session }) => ({
        state: (await supervisor.alive(sessionToWire(session)))
          ? "live"
          : "gone",
      }),
      "session.list": ({ owner }) => supervisor.listSessions(owner),
      "session.sample": ({ sessions }) => supervisor.sampleSessions(sessions),
      "session.logs": async ({ session, lines }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return { text: await supervisor.log(id, Math.max(0, lines)) };
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
        await supervisor.discard(id);
        closeTerminals(id);
        return {};
      },
      "session.retire": async ({ session, checkoutPending }) => {
        const id = sessionToWire(session);
        await supervisor.discard(id, true, checkoutPending);
        closeTerminals(id);
        return {};
      },
      "workspace.observe": async ({ session, policy }) => {
        const observation = await supervisor.observeWorkspace(
          sessionToWire(session),
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
        return supervisor.gitContext(sessionToWire(target.session), {
          kind: "context",
          checkout: target.checkout,
        });
      },
      "workspace.describe": async ({ session }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return binding(
          await supervisor.sessionCheckout(id, { kind: "describe" })
        );
      },
      "workspace.select": async ({ session, path }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Agent is not bound to this workspace",
          });
        return binding(
          await supervisor.sessionCheckout(id, {
            kind: "select",
            path: path === null ? null : displayPath(path),
          })
        );
      },
    },
    opens: {
      "session.attach": async ({ session }) => {
        const id = sessionToWire(session);
        if (!(await supervisor.isBound(id)))
          throw new RunnerCallError({
            code: "not_found",
            message: "Session is not bound to this runner.",
          });
        const socket = await supervisor.attach(id);
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
