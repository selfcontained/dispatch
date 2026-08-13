import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { TailnetListener } from "../src/peers/tailnet-listener.js";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ConstructorParameters<typeof TailnetListener>[0]["log"];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

describe("TailnetListener", () => {
  let target: http.Server | null = null;
  let listener: TailnetListener | null = null;

  afterEach(async () => {
    await listener?.stop();
    listener = null;
    await new Promise<void>((resolve) => {
      if (!target) return resolve();
      target.close(() => resolve());
      target.closeAllConnections?.();
    });
    target = null;
  });

  it("delegates requests to the app server and preserves the caller socket", async () => {
    let seenRemote: string | undefined;
    target = http.createServer((req, res) => {
      seenRemote = req.socket.remoteAddress ?? undefined;
      res.end("ok");
    });
    // The target never listens — proves delegation, not accidental routing.
    const port = await freePort();
    listener = new TailnetListener({
      appServer: () => target!,
      port,
      tls: null,
      log: noopLog,
    });
    await listener.start("127.0.0.1");

    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = "";
        res.on("data", (c) => (data += String(c)));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      });
    });
    expect(body).toBe("ok");
    // The socket the handler sees is the listener's own — remoteAddress is real.
    expect(seenRemote).toContain("127.0.0.1");
  });

  it("reports its bound address including the IPv4-mapped form", async () => {
    target = http.createServer();
    const port = await freePort();
    listener = new TailnetListener({
      appServer: () => target!,
      port,
      tls: null,
      log: noopLog,
    });
    expect(listener.isBoundAddress("127.0.0.1")).toBe(false);
    await listener.start("127.0.0.1");
    expect(listener.address).toBe("127.0.0.1");
    expect(listener.isBoundAddress("127.0.0.1")).toBe(true);
    expect(listener.isBoundAddress("::ffff:127.0.0.1")).toBe(true);
    expect(listener.isBoundAddress("100.64.0.1")).toBe(false);
    expect(listener.isBoundAddress(undefined)).toBe(false);
    await listener.stop();
    expect(listener.address).toBeNull();
    expect(listener.isBoundAddress("127.0.0.1")).toBe(false);
  });
});
