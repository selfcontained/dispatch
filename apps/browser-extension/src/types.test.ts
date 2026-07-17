import { describe, expect, it } from "vitest";

import { isSafariRequest, isWorkerRequest } from "./types";

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

describe("isSafariRequest", () => {
  it.each([
    "pairing:begin",
    "pairing:status",
    "pairing:cancel",
    "picker:arm",
    "picker:disarm",
    "overlay:init",
    "agent:remember",
    "overlay:closed",
  ])("accepts the %s request type", (type) => {
    expect(isSafariRequest({ type })).toBe(true);
  });

  it.each([
    null,
    {},
    { type: 1 },
    { type: "pairing:start" },
    { type: "overlay:unknown" },
  ])("rejects an unsupported request: %j", (request) => {
    expect(isSafariRequest(request)).toBe(false);
  });
});
