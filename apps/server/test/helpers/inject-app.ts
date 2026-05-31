/**
 * Shared harness for integration tests that boot a full Fastify app against an
 * isolated test database.  Eliminates the duplicated beforeAll / afterAll /
 * uncaughtException-filter boilerplate across route-level test files.
 *
 * Usage:
 *
 *   const ctx = useInjectApp();           // registers beforeAll + afterAll
 *   // ctx.pool, ctx.app, ctx.auth are populated by beforeAll
 *
 *   beforeEach(async () => {
 *     // per-test table cleanup
 *     sessionCookie = await ctx.sessionCookie();
 *   });
 */
import { afterAll, beforeAll, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  setupTestDb,
  teardownTestDb,
  runTestMigrations,
  getTestDatabaseUrl,
} from "../db/setup.js";

export interface InjectAppContext {
  pool: Pool;
  app: FastifyInstance;
  auth: typeof import("../../src/auth.js");
  /** Create a fresh session and return a signed cookie string ready for inject(). */
  sessionCookie: () => Promise<string>;
}

export interface InjectAppOptions {
  /** Whether to POST /auth/setup with a password (default: true). */
  setupAuth?: boolean;
  /** Extra env vars to set during the test; cleaned up in afterAll. */
  env?: Record<string, string>;
}

// The MCP SDK's StreamableHTTP transport schedules a 500ms drain timer
// that calls socket.destroySoon() — which Fastify inject() sockets don't
// implement. Swallow only that specific teardown error.
const uncaughtExceptionFilter = (err: Error): void => {
  if (
    err instanceof TypeError &&
    err.message.includes("destroySoon is not a function")
  ) {
    return;
  }
  throw err;
};

export function useInjectApp(opts?: InjectAppOptions): InjectAppContext {
  const setupAuth = opts?.setupAuth ?? true;
  const extraEnv = opts?.env ?? {};

  const ctx = {} as InjectAppContext;

  beforeAll(async () => {
    process.prependListener("uncaughtException", uncaughtExceptionFilter);

    const pool = await setupTestDb();
    await runTestMigrations();

    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.DISPATCH_AGENT_RUNTIME = "inert";
    process.env.DISPATCH_PORT = "0";
    process.env.DISPATCH_HOST = "127.0.0.1";
    for (const [k, v] of Object.entries(extraEnv)) {
      process.env[k] = v;
    }

    const auth = await import("../../src/auth.js");
    const serverModule = await import("../../src/server.js");
    const app = await serverModule.initializeApp({
      runMigrations: false,
      reconcileState: false,
    });

    if (setupAuth) {
      const setupResponse = await app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        payload: { password: "hunter2hunter2" },
      });
      expect(setupResponse.statusCode).toBe(200);
    }

    ctx.pool = pool;
    ctx.app = app;
    ctx.auth = auth;
    ctx.sessionCookie = async () => {
      const session = await auth.createSession(pool);
      const signed = (
        app as FastifyInstance & { signCookie: (value: string) => string }
      ).signCookie(session);
      return `dispatch_session=${signed}`;
    };
  });

  afterAll(async () => {
    const serverModule = await import("../../src/server.js");
    await serverModule.closeApp();
    delete process.env.DISPATCH_AGENT_RUNTIME;
    delete process.env.DATABASE_URL;
    delete process.env.DISPATCH_PORT;
    delete process.env.DISPATCH_HOST;
    for (const k of Object.keys(extraEnv)) {
      delete process.env[k];
    }
    await teardownTestDb();
    await new Promise((resolve) => setTimeout(resolve, 600));
    process.off("uncaughtException", uncaughtExceptionFilter);
  });

  return ctx;
}
