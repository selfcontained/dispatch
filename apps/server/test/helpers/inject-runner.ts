import { once } from "node:events";
import { connect } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { exchangeCode } from "../../src/agents/remote/enrollment.js";
import {
  type ReadyFrame,
  type ResultFrame,
  type ServiceFrame,
} from "../../src/agents/remote/protocol.js";
import { wireFrames } from "../../src/runners/enrolled/v1-framing.js";
import { generateRunnerKey } from "../../src/agents/remote/x509.js";

type Request = Extract<ServiceFrame, { type: "request" }>;

export type EnrolledRunnerOptions = {
  ready: Omit<ReadyFrame, "type" | "version">;
  answer: (command: Request["command"]) => Promise<ResultFrame["value"]>;
};

/** Pair over the enrolled listener and answer actual service commands over mTLS. */
export async function connectEnrolledRunner(
  app: FastifyInstance,
  cookie: string,
  options: EnrolledRunnerOptions
) {
  const url = "/api/v1/runners";
  const registration = await app.inject({
    method: "POST",
    url,
    headers: { cookie },
    payload: { name: "Inject test runner" },
  });
  expect(registration.statusCode).toBe(201);
  // The registration response publishes the same pairing flags used by the CLI.
  const { command } = registration.json<{ command: string }>();
  function flag(name: string) {
    const value = new RegExp(`--${name} (\\S+)`).exec(command)?.[1];
    if (!value) throw new Error(`Pairing command is missing --${name}`);
    return value;
  }

  const endpoint = flag("endpoint");
  const key = generateRunnerKey();
  const enrolled = await exchangeCode({
    endpoint,
    pin: flag("ca-sha256"),
    code: flag("code"),
    publicKey: key.publicKey,
    timeoutMs: 3_000,
  });
  const address = new URL(endpoint);
  const socket = connect({
    host: address.hostname,
    port: Number(address.port),
    ca: enrolled.ca,
    cert: enrolled.cert,
    key: key.key,
  });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  // Keep a socket error after the initial handshake from escaping teardown.
  socket.on("error", () => socket.destroy());
  const close = async () => {
    socket.destroy();
    await closed;
  };

  try {
    const send = wireFrames<ServiceFrame, ReadyFrame | ResultFrame>(
      socket,
      (frame) => {
        if (frame.type !== "request") return;
        void options.answer(frame.command).then(
          (value) => send({ type: "result", id: frame.id, value }),
          (error: Error) =>
            send({ type: "result", id: frame.id, error: error.message })
        );
      }
    );
    await once(socket, "secureConnect", { signal: AbortSignal.timeout(3_000) });
    send({ ...options.ready, type: "ready", version: 1 });
    const deadline = Date.now() + 3_000;
    do {
      const response = await app.inject({ url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const { runners } = response.json<{
        runners: Array<{ id: string; status: string }>;
      }>();
      if (
        runners.some(
          (runner) => runner.id === enrolled.id && runner.status === "online"
        )
      )
        return { id: enrolled.id, close };
      await delay(20);
    } while (Date.now() < deadline && !socket.destroyed);
    throw new Error("The enrolled test runner did not come online.");
  } catch (error) {
    await close();
    throw error;
  }
}
