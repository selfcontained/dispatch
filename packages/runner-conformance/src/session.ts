import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  RunnerCallError,
  clientMessage,
  hostMessage,
  type CallerChannel,
  type Infer,
  type Req,
  type Runner,
  type SessionHandle,
} from "@dispatch/runner-protocol/contract";

type HostMessage = Infer<typeof hostMessage>;
type JournalEvent = Extract<HostMessage, { type: "event" }>;
type SessionChannel = CallerChannel<"session.attach">;

export const CONFORMANCE_OWNER = "conformance-controller";

export function launchRequest(
  session: SessionHandle,
  config: Partial<Pick<Req<"session.launch">, "env" | "mcp">> = {}
): Req<"session.launch"> {
  return {
    session,
    launchId: randomUUID(),
    engine: "claude",
    model: null,
    effort: null,
    access: "default",
    resume: null,
    systemText: null,
    firstText: null,
    overflowNotice: null,
    env: {},
    mcp: [],
    owner: CONFORMANCE_OWNER,
    ...config,
  };
}

function exchange(
  channel: SessionChannel,
  request: Infer<typeof clientMessage>,
  done: (message: HostMessage) => boolean
): Promise<HostMessage[]> {
  const messages: HostMessage[] = [];
  let dispose = () => {};
  return new Promise<HostMessage[]>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`The host did not complete ${request.type} in 5 s.`)),
      5_000
    );
    const offClose = channel.onClose((error) =>
      reject(new Error(error?.message ?? "The host channel closed."))
    );
    const offData = channel.onData((message) => {
      if (!hostMessage.check(message)) {
        reject(new Error("Host message is outside its schema."));
        return;
      }
      if (message.type === "error" || message.type === "prompt_deferred") {
        reject(
          new Error(
            message.type === "error"
              ? message.message
              : "The host deferred the prompt."
          )
        );
        return;
      }
      messages.push(message);
      if (done(message)) resolve(messages);
    });
    dispose = () => {
      clearTimeout(timer);
      offClose();
      offData();
    };
    if (!clientMessage.check(request))
      throw new Error("Client message is outside its schema.");
    channel.write(request);
  }).finally(() => dispose());
}

export async function replay(
  channel: SessionChannel,
  fromSeq: number,
  journalId?: string
) {
  const messages = await exchange(
    channel,
    { type: "hello", fromSeq, journalId, replayComplete: true },
    (message) => message.type === "replay_complete"
  );
  const [welcome, ...frames] = messages;
  if (
    welcome?.type !== "welcome" ||
    !welcome.journalId ||
    !welcome.replayCompleteSupported
  )
    throw new Error("Expected a host welcome with replay completion support.");
  if (journalId !== undefined && welcome.journalId !== journalId)
    throw new Error("The journal changed on reconnect.");
  const events = frames.filter(
    (message): message is JournalEvent => message.type === "event"
  );
  checkPositions(events, fromSeq, welcome.journalId);
  if ((events.at(-1)?.seq ?? fromSeq) !== welcome.journalSeq)
    throw new Error("Replay completed before reaching the welcome cursor.");
  return { welcome, events, journalId: welcome.journalId };
}

function checkPositions(
  events: JournalEvent[],
  fromSeq: number,
  journalId: string
) {
  for (const [index, entry] of events.entries())
    if (entry.seq !== fromSeq + index + 1 || entry.journalId !== journalId)
      throw new Error(
        `Unexpected journal entry ${entry.seq} after cursor ${fromSeq + index}.`
      );
}

export async function promptSession(
  runner: Runner,
  session: SessionHandle,
  text: string
) {
  const { channel, welcome, journalId } = await attachReady(runner, session);
  try {
    const id = randomUUID();
    const messages = await exchange(
      channel,
      { type: "prompt", id, text, journalId },
      (message) =>
        message.type === "event" &&
        message.event.type === "turn" &&
        message.event.state === "settled"
    );
    const events = messages.filter(
      (message): message is JournalEvent =>
        message.type === "event" && message.seq > 0
    );
    checkPositions(events, welcome.journalSeq, journalId);
    if (
      !messages.some(
        (message) => message.type === "prompt_accepted" && message.id === id
      )
    )
      throw new Error("The host did not acknowledge the prompt.");
    const started = events.find(({ event }) => event.type === "turn");
    if (
      started?.event.type !== "turn" ||
      started.event.state !== "started" ||
      started.event.text !== text
    )
      throw new Error("The host did not journal the requested turn start.");
    const settled = events.at(-1)?.event;
    if (
      settled?.type !== "turn" ||
      settled.state !== "settled" ||
      settled.stopReason !== "end_turn" ||
      settled.error
    )
      throw new Error(
        `The turn did not finish successfully: ${JSON.stringify(settled)}`
      );
    return { events, journalId, fromSeq: welcome.journalSeq };
  } finally {
    channel.close();
  }
}

/** Launch can acknowledge before the host is listening or its engine is ready. */
async function attachReady(runner: Runner, session: SessionHandle) {
  const deadline = performance.now() + 5_000;
  while (true) {
    const opened = await runner
      .open("session.attach", { session })
      .catch((error: unknown) => {
        if (
          performance.now() < deadline &&
          error instanceof RunnerCallError &&
          ["failed", "host_gone", "unavailable"].includes(error.code)
        )
          return undefined;
        throw error;
      });
    if (opened) {
      try {
        const { welcome, journalId } = await replay(opened.channel, 0);
        if (welcome.running)
          return { channel: opened.channel, welcome, journalId };
      } catch (error) {
        opened.channel.close();
        throw error;
      }
      opened.channel.close();
      if (performance.now() >= deadline)
        throw new Error("The session engine did not become ready in 5 s.");
    }
    await delay(50);
  }
}

export function turnText(events: readonly JournalEvent[]): string {
  return events
    .map(({ event }) => {
      if (event.type !== "update") return "";
      const update = event.update;
      if (
        !update ||
        typeof update !== "object" ||
        Array.isArray(update) ||
        update.sessionUpdate !== "agent_message_chunk"
      )
        return "";
      const { content } = update;
      return content &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        content.type === "text" &&
        typeof content.text === "string"
        ? content.text
        : "";
    })
    .join("");
}
