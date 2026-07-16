import { describe, expect, it } from "vitest";

import { isWorkerRequest } from "./types";

describe("isWorkerRequest", () => {
  it.each([
    "connection:status",
    "connection:disconnect",
    "pairing:start",
    "pairing:exchange",
    "agents:list",
    "submission:create",
  ])("accepts the %s request type", (type) => {
    expect(isWorkerRequest({ type })).toBe(true);
  });

  it.each([
    null,
    {},
    { type: 1 },
    { type: "connection:unknown" },
    { type: "settings:update" },
  ])("rejects an unsupported request: %j", (request) => {
    expect(isWorkerRequest(request)).toBe(false);
  });
});
