// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, availabilityEvents, DatabaseUnavailableError } from "./api";

describe("api database availability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a database 503 globally and preserves its server message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "DATABASE_UNAVAILABLE",
            message: "Database authentication failed. Retrying connection.",
          }),
          { status: 503, headers: { "content-type": "application/json" } }
        )
      )
    );
    const listener = vi.fn();
    availabilityEvents.addEventListener("database-unavailable", listener);

    await expect(api("/api/v1/agents")).rejects.toEqual(
      expect.objectContaining({
        name: "DatabaseUnavailableError",
        message: "Database authentication failed. Retrying connection.",
      })
    );

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      message: "Database authentication failed. Retrying connection.",
    });
    availabilityEvents.removeEventListener("database-unavailable", listener);
  });

  it("does not turn unrelated HTTP errors into database outages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }))
    );

    await expect(api("/api/v1/missing")).rejects.not.toBeInstanceOf(
      DatabaseUnavailableError
    );
  });
});
