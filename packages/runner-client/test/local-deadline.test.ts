/*
 * A local call's reply deadline follows its request: a command that names a
 * timeout waits that long plus 5 s; one that names none waits as long as it
 * runs (repo tools have no deadline, as on main).
 */
import { describe, expect, it } from "vitest";
import { operations } from "@dispatch/runner-protocol/contract";
import { localDeadlineMs } from "../src/transport/local-socket.js";

describe("localDeadlineMs", () => {
  const exec = operations["checkout.exec"];

  it("waits a command's own timeout plus 5 s", () => {
    expect(localDeadlineMs(exec, { timeoutMs: 15_000 })).toBe(20_000);
  });

  it("sets no deadline for a command without a timeout", () => {
    expect(localDeadlineMs(exec, { timeoutMs: null })).toBeNull();
  });

  it("keeps the contract class for other calls", () => {
    expect(localDeadlineMs(operations["runner.describe"])).toBe(20_000);
    expect(localDeadlineMs(operations["checkout.read"])).toBe(300_000);
  });
});
