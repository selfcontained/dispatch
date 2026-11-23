import {
  chmodSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildEngineLoginApp,
  type GoldenVia,
} from "./engine-login-golden-setup.js";

/*
 * Pins main's `/api/v1/system/engines/*` responses: bodies byte for byte
 * (ids and times masked), status codes, error text and when each login state
 * shows. Fixture CLIs and a fixture HOME only: no real CLI, credential or
 * login shell is touched.
 */

const CLAUDE_OUTPUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz
Paste code here if prompted > `;

const CODEX_OUTPUT = `Welcome to Codex

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   R7CN-6RVWW
`;

let dir: string;
let home: string;
let claude: string;
let codex: string;
let app: FastifyInstance | null = null;
let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-login-golden-"));
  home = path.join(dir, "home");
  mkdirSync(home);
  const fake = path.join(dir, "fake-cli.mjs");
  writeFileSync(
    fake,
    `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mode = process.env.FAKE_LOGIN_MODE ?? "";
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  console.log("1.2.3");
} else if (args === "auth status --json") {
  console.log(JSON.stringify(mode === "signed-out" ? { loggedIn: false } : { loggedIn: true, email: "me@example.com" }));
} else if (args === "login status") {
  if (mode === "signed-out") { console.log("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT");
} else if (args === "auth login") {
  if (process.env.FAKE_PID_FILE) require("node:fs").writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
  const print = () => process.stdout.write(${JSON.stringify(CLAUDE_OUTPUT)});
  if (mode === "slow-link") setTimeout(print, 400); else print();
  process.stdin.once("data", (chunk) => {
    if (chunk.toString().trim() === "good") setTimeout(() => process.exit(0), 100);
    else { console.error("OAuth error: invalid code"); process.exit(1); }
  });
} else if (args === "login --device-auth") {
  process.stdout.write(${JSON.stringify(CODEX_OUTPUT)});
  setTimeout(() => process.exit(0), 200);
} else {
  process.exit(2);
}
`
  );
  const shim = (name: string) => {
    const file = path.join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`
    );
    chmodSync(file, 0o755);
    return file;
  };
  claude = shim("claude");
  codex = shim("codex");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  await app?.close();
  app = null;
  await cleanup?.();
  cleanup = null;
});

let via: GoldenVia = "in-process";

async function build(
  opts: { installed?: boolean; mode?: string; linkTimeoutMs?: number } = {}
) {
  const installed = opts.installed ?? true;
  await cleanup?.();
  app = Fastify();
  cleanup = await buildEngineLoginApp(app, {
    via,
    bins: {
      claude: installed ? claude : path.join(dir, "missing-claude"),
      codex: installed ? codex : path.join(dir, "missing-codex"),
      opencode: path.join(dir, "missing-opencode"),
    },
    env: {
      PATH: process.env.PATH,
      HOME: home,
      FAKE_LOGIN_MODE: opts.mode,
      FAKE_PID_FILE: path.join(dir, "login.pid"),
    },
    ...(opts.linkTimeoutMs ? { linkTimeoutMs: opts.linkTimeoutMs } : {}),
  });
  return app;
}

/** The body with ids and times masked, key order kept: what goes on the wire. */
function wire(body: string): string {
  return JSON.stringify(JSON.parse(body), (key, value) =>
    key === "id"
      ? "<id>"
      : key === "expiresAt" || key === "finishedAt"
        ? "<time>"
        : value
  );
}

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown
) {
  const res = await app!.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: wire(res.body), raw: res.body };
}

async function until(check: () => Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const loginId = (raw: string) =>
  (JSON.parse(raw) as { login: { id: string } }).login.id;

describe.each(["child", "in-process"] as const)(
  "main's engine sign-in routes, local runner %s",
  (mode) => {
    beforeAll(() => {
      via = mode;
    });

    it("reports each engine's sign-in", async () => {
      await build();
      expect(await call("GET", "/api/v1/system/engines/auth")).toMatchObject({
        status: 200,
        body: '{"engines":[{"engine":"claude","installed":true,"signedIn":true,"detail":"me@example.com"},{"engine":"codex","installed":true,"signedIn":true,"detail":"ChatGPT"}]}',
      });
    });

    it("reports signed-out and missing engines", async () => {
      await build({ mode: "signed-out" });
      expect((await call("GET", "/api/v1/system/engines/auth")).body).toBe(
        '{"engines":[{"engine":"claude","installed":true,"signedIn":false},{"engine":"codex","installed":true,"signedIn":false}]}'
      );
      await app!.close();
      await build({ installed: false });
      expect((await call("GET", "/api/v1/system/engines/auth")).body).toBe(
        '{"engines":[{"engine":"claude","installed":false,"signedIn":false},{"engine":"codex","installed":false,"signedIn":false}]}'
      );
    });

    it("has no sign-in for other engines", async () => {
      await build();
      for (const method of ["GET", "POST"] as const) {
        expect(
          await call(method, "/api/v1/system/engines/opencode/login", {})
        ).toMatchObject({
          status: 404,
          body: '{"error":"No sign-in for that engine."}',
        });
      }
    });

    it("refuses a bad body and a missing code", async () => {
      await build();
      expect(
        await call("POST", "/api/v1/system/engines/claude/login", {
          restart: "yes",
        })
      ).toMatchObject({ status: 400, body: '{"error":"Invalid body."}' });
      expect(
        await call("POST", "/api/v1/system/engines/logins/nope/code", {})
      ).toMatchObject({
        status: 400,
        body: '{"error":"Paste the code to continue."}',
      });
    });

    it("does not know a login it never started", async () => {
      await build();
      const missing = {
        status: 404,
        body: '{"error":"Sign-in not found."}',
      };
      expect(await call("GET", "/api/v1/system/engines/logins/nope")).toEqual(
        expect.objectContaining(missing)
      );
      expect(
        await call("POST", "/api/v1/system/engines/logins/nope/code", {
          code: "x",
        })
      ).toEqual(expect.objectContaining(missing));
      expect(
        await call("DELETE", "/api/v1/system/engines/logins/nope")
      ).toEqual(expect.objectContaining(missing));
      expect(await call("GET", "/api/v1/system/engines/claude/login")).toEqual(
        expect.objectContaining({ status: 200, body: '{"login":null}' })
      );
    });

    it("signs Claude in with the code, state by state", async () => {
      await build();
      const started = await call(
        "POST",
        "/api/v1/system/engines/claude/login",
        {}
      );
      // The answer waits for the link.
      expect(started).toMatchObject({
        status: 200,
        body: '{"login":{"id":"<id>","engine":"claude","status":"waiting","needsCode":true,"expiresAt":"<time>","url":"https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"}}',
      });
      const id = loginId(started.raw);
      expect(
        (await call("GET", "/api/v1/system/engines/claude/login")).body
      ).toBe(started.body);
      expect(
        (await call("GET", `/api/v1/system/engines/logins/${id}`)).body
      ).toBe(started.body);
      // Joining the waiting login returns it.
      const joined = await call(
        "POST",
        "/api/v1/system/engines/claude/login",
        {}
      );
      expect(loginId(joined.raw)).toBe(id);
      // The code goes in and the answer says so at once.
      expect(
        await call("POST", `/api/v1/system/engines/logins/${id}/code`, {
          code: " good ",
        })
      ).toMatchObject({
        status: 200,
        body: '{"login":{"id":"<id>","engine":"claude","status":"verifying","needsCode":true,"expiresAt":"<time>","url":"https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"}}',
      });
      await until(async () =>
        (
          await call("GET", "/api/v1/system/engines/claude/login")
        ).body.includes('"succeeded"')
      );
      const done = await call("GET", "/api/v1/system/engines/claude/login");
      expect(done.body).toBe(
        '{"login":{"id":"<id>","engine":"claude","status":"succeeded","needsCode":true,"expiresAt":"<time>","detail":"me@example.com","finishedAt":"<time>"}}'
      );
      expect(loginId(done.raw)).toBe(id);
    });

    it("shows a login as starting while its link is on the way", async () => {
      await build({ mode: "slow-link" });
      const pending = call("POST", "/api/v1/system/engines/claude/login", {});
      await until(async () =>
        (
          await call("GET", "/api/v1/system/engines/claude/login")
        ).body.includes('"starting"')
      );
      expect(
        (await call("GET", "/api/v1/system/engines/claude/login")).body
      ).toBe(
        '{"login":{"id":"<id>","engine":"claude","status":"starting","needsCode":true,"expiresAt":"<time>"}}'
      );
      expect((await pending).body).toContain('"status":"waiting"');
    });

    it("finishes Codex's device flow on its own", async () => {
      await build();
      const started = await call(
        "POST",
        "/api/v1/system/engines/codex/login",
        {}
      );
      expect(started.body).toBe(
        '{"login":{"id":"<id>","engine":"codex","status":"waiting","needsCode":false,"expiresAt":"<time>","url":"https://auth.openai.com/codex/device","userCode":"R7CN-6RVWW"}}'
      );
      const id = loginId(started.raw);
      await until(async () =>
        (
          await call("GET", `/api/v1/system/engines/logins/${id}`)
        ).body.includes('"succeeded"')
      );
      expect(
        (await call("GET", `/api/v1/system/engines/logins/${id}`)).body
      ).toBe(
        '{"login":{"id":"<id>","engine":"codex","status":"succeeded","needsCode":false,"expiresAt":"<time>","detail":"ChatGPT","finishedAt":"<time>"}}'
      );
    });

    it("reports a rejected code with the CLI's words", async () => {
      await build();
      const id = loginId(
        (await call("POST", "/api/v1/system/engines/claude/login", {})).raw
      );
      await call("POST", `/api/v1/system/engines/logins/${id}/code`, {
        code: "bad",
      });
      await until(async () =>
        (
          await call("GET", `/api/v1/system/engines/logins/${id}`)
        ).body.includes('"failed"')
      );
      expect(
        (await call("GET", `/api/v1/system/engines/logins/${id}`)).body
      ).toBe(
        '{"login":{"id":"<id>","engine":"claude","status":"failed","needsCode":true,"expiresAt":"<time>","error":"OAuth error: invalid code","finishedAt":"<time>"}}'
      );
    });

    it("cancels, and starts over on request", async () => {
      await build();
      const first = loginId(
        (await call("POST", "/api/v1/system/engines/claude/login", {})).raw
      );
      const fresh = await call("POST", "/api/v1/system/engines/claude/login", {
        restart: true,
      });
      const second = loginId(fresh.raw);
      expect(second).not.toBe(first);
      expect(
        (await call("GET", `/api/v1/system/engines/logins/${first}`)).body
      ).toBe(
        '{"login":{"id":"<id>","engine":"claude","status":"cancelled","needsCode":true,"expiresAt":"<time>","finishedAt":"<time>"}}'
      );
      expect(
        await call("DELETE", `/api/v1/system/engines/logins/${second}`)
      ).toMatchObject({
        status: 200,
        body: '{"login":{"id":"<id>","engine":"claude","status":"cancelled","needsCode":true,"expiresAt":"<time>","finishedAt":"<time>"}}',
      });
      // Cancelling again returns how it ended.
      expect(
        (await call("DELETE", `/api/v1/system/engines/logins/${second}`)).status
      ).toBe(200);
      expect(
        loginId((await call("GET", "/api/v1/system/engines/claude/login")).raw)
      ).toBe(second);
    });

    it("reports a missing CLI as a failed login", async () => {
      await build({ installed: false });
      expect(
        await call("POST", "/api/v1/system/engines/codex/login", {})
      ).toMatchObject({
        status: 200,
        body: '{"login":{"id":"<id>","engine":"codex","status":"failed","needsCode":false,"expiresAt":"<time>","error":"Codex is not installed on this machine.","finishedAt":"<time>"}}',
      });
    });

    it("gives up on a CLI that never prints its link", async () => {
      await build({ mode: "slow-link", linkTimeoutMs: 100 });
      expect(
        (await call("POST", "/api/v1/system/engines/claude/login", {})).body
      ).toBe(
        '{"login":{"id":"<id>","engine":"claude","status":"failed","needsCode":true,"expiresAt":"<time>","error":"The CLI did not print a sign-in link. Run the login in a terminal on the machine running Dispatch.","finishedAt":"<time>"}}'
      );
    });

    it("cancels a login under way when the app closes", async () => {
      await build();
      rmSync(path.join(dir, "login.pid"), { force: true });
      await call("POST", "/api/v1/system/engines/claude/login", {});
      const pid = Number(readFileSync(path.join(dir, "login.pid"), "utf8"));
      expect(alive(pid)).toBe(true);
      await app!.close();
      app = null;
      await until(async () => !alive(pid));
    });
  }
);
