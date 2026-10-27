import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { resolveTilde } from "../src/shared/lib/resolve-tilde.js";

import {
  httpLoggingOptions,
  registerHttpLogging,
} from "../src/server/http-logging.js";

async function fixture(debug = false) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const options = httpLoggingOptions({
    DISPATCH_HTTP_DEBUG: debug ? "1" : "0",
  });
  const app = Fastify({
    ...options,
    logger: { ...(options.logger as object), stream },
  });
  registerHttpLogging(app);
  app.get("/ok/:id", async () => ({ ok: true }));
  app.get("/failed/:id", async (_request, reply) => reply.code(503).send({}));
  app.get("/denied", async (_request, reply) => reply.code(401).send({}));
  app.post("/throw/:id", async () => {
    throw Object.assign(new TypeError("secret-error-text"), { code: "ENOENT" });
  });
  app.get("/source-error", async () => resolveTilde(null as never));
  app.get("/bundled-error", async () => {
    throw Object.assign(new Error("secret-message"), {
      stack:
        "Error: secret-message\n    at handler (/$bunfs/root/secret-file:123:456)",
    });
  });
  app.get("/untrusted-error", async () => {
    throw Object.assign(new Error("secret-message"), {
      name: "secret-name",
      code: "secret-code",
      stack:
        "secret-message\n    at secret-frame (/private/secret-source.ts:12:34)",
    });
  });
  app.get("/bad-input", async () => {
    throw Object.assign(new Error("secret-validation"), { statusCode: 400 });
  });
  app.log.info("startup marker");
  app.log.warn("warning marker");
  app.log.error("error marker");
  return {
    app,
    lines,
    logs: () =>
      lines
        .join("")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
  };
}

describe("HTTP logging", () => {
  it("quiets successful traffic at info while preserving startup and explicit warnings/errors", async () => {
    const { app, logs } = await fixture();
    try {
      await app.inject("/ok/private-id?token=secret-query");
      expect(logs().map((log) => log.msg)).toEqual([
        "startup marker",
        "warning marker",
        "error marker",
      ]);
    } finally {
      await app.close();
    }
  });

  it("logs thrown and returned failures with correlation and safe route templates", async () => {
    const { app, logs, lines } = await fixture();
    try {
      await app.inject("/failed/private-id?token=secret-query");
      await app.inject("/denied");
      await app.inject({
        method: "POST",
        url: "/throw/private-id?token=secret-query",
        headers: {
          authorization: "Bearer secret-header",
          cookie: "token=secret-cookie",
        },
        payload: { password: "secret-body" },
      });
      await app.inject("/bad-input");
      await app.inject("/missing-secret-path?token=secret-query");
      const failures = logs().filter(
        (log) => log.msg === "HTTP request failed"
      );
      expect(failures).toHaveLength(5);
      expect(failures.map((log) => log.level)).toEqual([50, 40, 50, 40, 40]);
      expect(failures[0]).toMatchObject({
        method: "GET",
        route: "/failed/:id",
        statusCode: 503,
      });
      expect(failures[2]).toMatchObject({
        method: "POST",
        route: "/throw/:id",
        statusCode: 500,
      });
      expect(failures[2]).toMatchObject({
        errorType: "TypeError",
        errorCode: "ENOENT",
      });
      // This test is outside the production source tree; its absolute stack
      // paths must not be copied into request logs.
      expect(failures[2].source).toBeUndefined();
      expect(failures.every((log) => typeof log.reqId === "string")).toBe(true);
      expect(lines.join("")).not.toMatch(/secret-|private-id/);
    } finally {
      await app.close();
    }
  });

  it("retains actionable source locations without absolute paths or virtual filenames", async () => {
    const { app, logs, lines } = await fixture();
    try {
      await app.inject("/source-error");
      await app.inject("/bundled-error");
      const failures = logs().filter(
        (log) => log.msg === "HTTP request failed"
      );
      expect(failures[0]).toMatchObject({ errorType: "TypeError" });
      expect(failures[0].source).toMatch(
        /^shared\/lib\/resolve-tilde\.ts:\d+:\d+$/
      );
      // Simulated compiled Bun frame; the real source frame above is live.
      expect(failures[1].source).toBe("bundled-server:123:456");
      expect(lines.join("")).not.toMatch(/secret-|\$bunfs|Users\//);
    } finally {
      await app.close();
    }
  });

  it("omits arbitrary error metadata and stack text", async () => {
    const { app, logs, lines } = await fixture();
    try {
      await app.inject("/untrusted-error");
      const failure = logs().find((log) => log.msg === "HTTP request failed");
      expect(failure).toMatchObject({ errorType: "Error", statusCode: 500 });
      expect(failure.errorCode).toBeUndefined();
      expect(failure.source).toBeUndefined();
      expect(lines.join("")).not.toContain("secret-");
    } finally {
      await app.close();
    }
  });

  it("opts into safe successful request pairs at debug without Fastify info pairs", async () => {
    const { app, logs, lines } = await fixture(true);
    try {
      await app.inject("/ok/private-id?token=secret-query");
      const requestLogs = logs().filter((log) =>
        log.msg.startsWith("HTTP request")
      );
      expect(requestLogs.map((log) => [log.level, log.msg, log.route])).toEqual(
        [
          [20, "HTTP request received", "/ok/:id"],
          [20, "HTTP request completed", "/ok/:id"],
        ]
      );
      expect(lines.join("")).not.toMatch(
        /secret-|private-id|incoming request|request completed".*level":30/
      );
    } finally {
      await app.close();
    }
  });
});
