import {
  isCheckoutReply,
  isCheckoutViewData,
  MAX_CHECKOUT_VIEW_BYTES,
  type CheckoutReadName,
  type CheckoutView,
  type Placement,
} from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  sessionToWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import { encodeCommand } from "@dispatch/runner-client/v1";
import { AgentError } from "../../agents/errors.js";
import {
  RunnerRevoked,
  type RemoteRunnerService,
} from "../../agents/remote/service.js";
import type { CheckoutSession } from "../directory.js";

function decodeCheckoutView(raw: unknown, view: CheckoutView) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw) > MAX_CHECKOUT_VIEW_BYTES
  )
    throw new AgentError("Invalid runner checkout response.", 502);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AgentError("Invalid runner checkout response.", 502);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    "error" in value &&
    [400, 403, 404, 409, 413, 500].includes(Number(value.status)) &&
    typeof value.error === "string"
  )
    throw new AgentError(value.error.slice(0, 256), Number(value.status));
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !isCheckoutViewData(view, value.data)
  )
    throw new AgentError("Invalid runner checkout response.", 502);
  return value.data;
}

export async function readLegacyCheckoutView(
  service: RemoteRunnerService | undefined,
  placement: Placement,
  agentId: string,
  query: CheckoutView
) {
  if (!service) throw new AgentError("The runner is unavailable.", 503);
  try {
    const { value } = await service.requestSession(placement, {
      kind: "viewCheckout",
      agentId,
      query,
    });
    return decodeCheckoutView(value, query);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      error instanceof Error
        ? error.message
        : "Unable to read the runner checkout.",
      error instanceof RunnerRevoked ? 403 : 503
    );
  }
}

function rename(value: object, from: string, to: string) {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key === from ? to : key,
      field,
    ])
  );
}

export async function callCheckoutRead<K extends CheckoutReadName>(
  service: RemoteRunnerService | undefined,
  placement: Placement | null,
  agent: CheckoutSession | undefined,
  op: K,
  request: Req<K>,
  signal?: AbortSignal,
  legacyView?: CheckoutView
): Promise<Res<K>> {
  const view =
    op !== "checkout.read" &&
    op !== "checkout.changes" &&
    op !== "checkout.defaultFiles" &&
    !(op === "checkout.list" && (request as Req<"checkout.list">).filesOnly);
  if (!service)
    throw view
      ? new AgentError("The runner is unavailable.", 503)
      : new AgentError("The agent’s runner is unavailable.", 409);
  if (
    !placement ||
    !agent ||
    !("session" in request.target) ||
    sessionToWire(request.target.session) !== agent.id ||
    // A runner holds one checkout per session, so its launch checkout is the
    // one it reads.
    (request.target.checkout ?? "current") === "moved"
  )
    throw new RunnerCallError({
      code: "invalid",
      message: "Invalid checkout read binding.",
    });

  const streamed = service.streamCheckoutRead?.(placement, op, request, signal);
  if (streamed) return streamed;
  // The legacy inspection carrier has no selector; it can only read current.
  if (
    request.target.checkout === "launch" ||
    request.target.checkout === "owned" ||
    ((op === "checkout.list" || op === "checkout.read") &&
      (request as Req<"checkout.read">).mode === "native")
  )
    throw new RunnerCallError({
      code: "unsupported",
      message: `Unsupported operation: ${op}`,
    });

  // The original caller query retains its key order in the v1 frame.
  const command = encodeCommand({
    op,
    request,
    extras: { workspace: placement.workspace, agentId: agent.id },
    absent: [],
  });
  if (command.kind === "viewCheckout") {
    const data = await readLegacyCheckoutView(
      service,
      placement,
      agent.id,
      legacyView ?? command.query
    );
    if (op === "checkout.image") return { bytes: data } as Res<K>;
    if (op === "checkout.stats" && data && typeof data === "object")
      return rename(data, "excludingTests", "excluded") as Res<K>;
    if (
      op === "checkout.diff" &&
      data &&
      typeof data === "object" &&
      "files" in data
    )
      return {
        ...data,
        files: (data.files as object[]).map((file) =>
          rename(file, "isTest", "excluded")
        ),
      } as Res<K>;
    return data as Res<K>;
  }
  if (command.kind !== "inspectCheckout")
    throw new Error("Invalid v1 checkout read command.");
  const { value } = await service.requestSession(placement, {
    kind: command.kind,
    agentId: command.agentId,
    query: command.query,
  });
  if (typeof value !== "string")
    throw new AgentError("Missing runner checkout response.", 502);
  let reply: unknown;
  try {
    reply = JSON.parse(value);
  } catch {
    throw new AgentError("Malformed runner checkout response.", 502);
  }
  if (!isCheckoutReply(reply, command.query))
    throw new AgentError("Invalid runner checkout response.", 502);
  if (reply.kind === "listFiles" && command.query.kind === "listFiles") {
    const path = command.query.path;
    return {
      entries: reply.names.map((name) => ({
        name,
        path: path + "/" + name,
        kind: "file",
      })),
      truncated: false,
    } as Res<K>;
  }
  if (reply.kind === "readFile")
    return (reply.content === null ? null : { data: reply.content }) as Res<K>;
  const { kind: _kind, ...data } = reply;
  return data as Res<K>;
}
