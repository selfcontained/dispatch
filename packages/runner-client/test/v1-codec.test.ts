import {
  isCheckoutCommandFile,
  isCheckoutCommandResult,
  isCheckoutObservation,
  isCheckoutReply,
  isCheckoutViewData,
  isGitHubPullRequestDetails,
  isGitHubPullRequestDiff,
  isGitHubPullRequestObservation,
  isSessionCheckout,
  isTerminalInfo,
  parseGitHubStatus,
  parseServiceFrame,
  parseUpdateServiceFrame,
  parseUpdateStatus,
  type Command,
  type ResultFrame,
} from "@dispatch/runner-protocol";
import {
  operationNames,
  operations,
  type OperationSpec,
} from "@dispatch/runner-protocol/contract";
import { describe, expect, it } from "vitest";
import {
  NOT_ON_V1,
  ResultError,
  decodeCommand,
  decodeError,
  decodeResult,
  decodeUpdateFrame,
  decodeUpdateStatus,
  encodeCommand,
  encodeError,
  encodeResult,
  encodeUpdateFrame,
  encodeUpdateStatus,
  type Decoded,
} from "../src/v1/codec.js";
import { legacy, results, statuses, updates } from "./v1-fixtures.js";

const spec = (op: string) => (operations as Record<string, OperationSpec>)[op]!;
const json = (value: unknown) =>
  typeof value === "string" ? safeParse(value) : value;

/** The v1 consumer's own validation of a result, so fixtures are real v1 replies. */
function validV1Result(command: Command, value: unknown): boolean {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  switch (command.kind) {
    case "viewCheckout": {
      const reply = parsed as { data?: unknown; status?: number };
      return "data" in reply
        ? isCheckoutViewData(command.query, reply.data)
        : typeof reply.status === "number";
    }
    case "inspectCheckout":
      return isCheckoutReply(parsed, command.query);
    case "sessionCheckout":
      return command.operation.kind === "context"
        ? operations["git.context"].response.check(parsed)
        : isSessionCheckout(parsed);
    case "checkoutRelease":
      return command.operation.kind === "observe"
        ? isCheckoutObservation(parsed)
        : ["released", "retained", "inUse"].includes(value as string);
    case "openTerminal":
      return isTerminalInfo(parsed);
    case "checkoutCommand":
      return command.operation.kind === "read"
        ? isCheckoutCommandFile(parsed)
        : isCheckoutCommandResult(parsed);
    case "github": {
      const type = command.operation.type;
      if (type === "pullRequestDetails")
        return parsed === null || isGitHubPullRequestDetails(parsed);
      if (type === "pullRequestDiff")
        return parsed === null || isGitHubPullRequestDiff(parsed);
      if (type === "pullRequestStatus")
        return isGitHubPullRequestObservation(parsed);
      if (["status", "login", "cancel", "logout"].includes(type))
        return parseGitHubStatus(parsed) !== null;
      return parsed !== null && typeof parsed === "object";
    }
    case "engine":
      return typeof (parsed as { ok?: unknown }).ok === "boolean";
    default:
      return typeof value === "string" || typeof value === "boolean";
  }
}
function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const label = ({ command }: (typeof results)[number]) =>
  `${command.kind}${"operation" in command ? `.${(command.operation as { type?: string; kind?: string }).type ?? (command.operation as { kind?: string }).kind}` : ""}${"query" in command ? `.${command.query.kind}` : ""}`;

describe("wire v1 requests round-trip through the codec", () => {
  it.each(results.map((fixture, i) => [label(fixture), i, fixture] as const))(
    "%s (#%i)",
    (_label, i, { command }) => {
      const id = `req-${i}`;
      expect(
        parseServiceFrame({ type: "request", id, command })
      ).not.toBeNull();
      const decoded = decodeCommand(command, id);
      expect(decoded.op).not.toBeNull();
      const { op, request } = decoded as Decoded;
      expect(spec(op).request.check(request)).toBe(true);
      const encoded = encodeCommand(decoded);
      // Same fields and values; JSON key order carries no meaning on v1.
      expect(encoded).toStrictEqual(command);
    }
  );

  it.each(legacy.map((command) => [command.kind, command] as const))(
    "legacy %s passes through unchanged",
    (_kind, command) => {
      expect(
        parseServiceFrame({ type: "request", id: "legacy", command })
      ).not.toBeNull();
      const decoded = decodeCommand(command, "legacy");
      expect(decoded.op).toBeNull();
      expect(encodeCommand(decoded)).toBe(command);
    }
  );
});

describe("wire v1 results round-trip through the codec", () => {
  it.each(results.map((fixture, i) => [label(fixture), i, fixture] as const))(
    "%s (#%i)",
    (_label, i, { command, value, events }) => {
      expect(validV1Result(command, value)).toBe(true);
      const decoded = decodeCommand(command, `req-${i}`) as Decoded;
      let response: unknown;
      try {
        response = decodeResult(decoded, value, events);
      } catch (error) {
        if (!(error instanceof ResultError)) throw error;
        response = error;
      }
      if (!(response instanceof ResultError))
        expect(spec(decoded.op).response.check(response)).toBe(true);
      const encoded = encodeResult(decoded, response as never);
      expect(json(encoded)).toStrictEqual(json(value));
    }
  );
});

describe("wire v1 errors", () => {
  it.each<Pick<ResultFrame, "error" | "code">>([
    { error: "Guest agent host has exited.", code: "host-gone" },
    { error: "The runner is updating.", code: "update-fenced" },
    { error: "Runner GitHub operation failed." },
  ])("%o round-trips", (fields) => {
    const error = decodeError({ type: "result", id: "x", ...fields });
    expect(error).not.toBeNull();
    expect(encodeError(error!)).toStrictEqual(fields);
  });

  it("a successful frame has no error", () => {
    expect(decodeError({ type: "result", id: "x", value: true })).toBeNull();
  });
});

describe("wire v1 update frames round-trip through the codec", () => {
  it.each(updates.map((frame) => [frame.type, frame] as const))(
    "%s",
    (_type, frame) => {
      expect(parseUpdateServiceFrame(frame)).toStrictEqual(frame);
      const decoded = decodeUpdateFrame(frame);
      expect(spec(decoded.op).request.check(decoded.request)).toBe(true);
      expect(encodeUpdateFrame(decoded)).toStrictEqual(frame);
    }
  );

  it.each(statuses.map((frame) => [frame.phase, frame] as const))(
    "status %s",
    (_phase, frame) => {
      expect(parseUpdateStatus(frame)).not.toBeNull();
      const status = decodeUpdateStatus(frame);
      expect(spec("update.offer").response.check(status)).toBe(true);
      expect(encodeUpdateStatus(status)).toStrictEqual(frame);
    }
  );
});

describe("codec coverage", () => {
  const mapped = new Set([
    ...results.map(({ command }, i) => decodeCommand(command, `${i}`).op),
    ...updates.map((frame) => decodeUpdateFrame(frame).op),
  ]);

  it("every operation is mapped from v1 or listed as not on v1", () => {
    for (const op of operationNames)
      expect(
        mapped.has(op) !== Object.hasOwn(NOT_ON_V1, op),
        `${op}: exactly one of mapped or NOT_ON_V1`
      ).toBe(true);
  });

  it("every v1 command kind has a fixture", () => {
    const kinds = new Set(
      [...results.map((r) => r.command), ...legacy].map((c) => c.kind)
    );
    expect([...kinds].sort()).toEqual(
      [
        "launch",
        "attach",
        "alive",
        "discard",
        "log",
        "stop",
        "sessionFile",
        "watchCheckout",
        "openTerminal",
        "viewCheckout",
        "inspectCheckout",
        "sessionCheckout",
        "checkoutCommand",
        "checkoutRelease",
        "repo",
        "engine",
        "github",
      ].sort()
    );
  });
});
