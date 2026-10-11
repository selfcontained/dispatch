import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import Fastify from "fastify";

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import {
  EngineLogins,
  loginScript,
  parseLoginOutput,
} from "../src/agents/engine-login.js";
import { registerEngineLoginRoutes } from "../src/routes/engine-login.js";

const CLAUDE_OUTPUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz
Paste code here if prompted > `;

const CODEX_OUTPUT = `\x1b[1mWelcome to Codex\x1b[0m

1. Open this link in your browser and sign in to your account
   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code (expires in 15 minutes)
   \x1b[94mR7CN-6RVWW\x1b[0m
`;

describe("parseLoginOutput", () => {
  it("reads Claude's link", () => {
    expect(parseLoginOutput("claude", CLAUDE_OUTPUT)).toEqual({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz",
    });
  });

  it("waits for Codex's code after its link", () => {
    expect(parseLoginOutput("codex", CODEX_OUTPUT.split("2.")[0]!)).toBeNull();
    expect(parseLoginOutput("codex", CODEX_OUTPUT)).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "R7CN-6RVWW",
    });
  });

  it("finds nothing before the link", () => {
    expect(
      parseLoginOutput("claude", "Opening browser to sign in…")
    ).toBeNull();
  });
});

describe("EngineLogins", () => {
  let dir: string;
  let fake: string;
  let logins: EngineLogins;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-engine-login-"));
    fake = path.join(dir, "fake-cli.mjs");
    // A stand-in CLI: `auth login` prints Claude's link and takes a code on
    // stdin ("good" signs in, anything else fails); `login --device-auth`
    // prints Codex's link and code and signs in on its own; the status
    // commands report the account.
    writeFileSync(
      fake,
      `
const mode = process.env.FAKE_LOGIN_MODE;
const args = process.argv.slice(2).join(" ");
if (mode === "fail") {
  console.error("Error: could not reach the sign-in service");
  process.exit(1);
} else if (mode === "silent") {
  process.stdin.resume();
} else if (mode === "reject-with-link") {
  process.stdout.write(${JSON.stringify(CLAUDE_OUTPUT)});
  process.stdin.once("data", () => {
    console.error("Invalid code for https://claude.com/cai/oauth/authorize?state=secret");
    process.exit(1);
  });
} else if (args === "auth status --json") {
  console.log(JSON.stringify({ loggedIn: true, email: "me@example.com" }));
} else if (args === "login status") {
  console.log("Logged in using ChatGPT");
} else if (args === "auth login") {
  process.stdout.write(${JSON.stringify(CLAUDE_OUTPUT)});
  process.stdin.once("data", (chunk) => {
    if (chunk.toString().trim() === "good") process.exit(0);
    console.error("OAuth error: invalid code");
    process.exit(1);
  });
} else if (args === "login --device-auth") {
  process.stdout.write(${JSON.stringify(CODEX_OUTPUT)});
  setTimeout(() => process.exit(0), 200);
} else {
  process.exit(2);
}
`
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => logins?.close());

  const make = (
    bin: string | null = "fake",
    opts: { mode?: string; linkTimeoutMs?: number } = {}
  ) =>
    new EngineLogins({
      resolveBin: async () => bin,
      command: (_bin, args) => ({
        bin: process.execPath,
        args: [fake, ...args],
      }),
      env: { ...process.env, FAKE_LOGIN_MODE: opts.mode ?? "" },
      ...(opts.linkTimeoutMs ? { linkTimeoutMs: opts.linkTimeoutMs } : {}),
    });

  const until = async (
    check: () => boolean,
    timeoutMs = 5_000
  ): Promise<void> => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("signs Claude in with the code from the sign-in page", async () => {
    logins = make();
    const login = await logins.start("claude");
    expect(login).toMatchObject({
      status: "waiting",
      needsCode: true,
      url: expect.stringContaining("https://claude.com/cai/oauth/authorize"),
    });
    expect(logins.submitCode(login.id, "  good \n")?.status).toBe("verifying");
    await until(() => logins.get(login.id)?.status === "succeeded");
    const done = logins.get(login.id)!;
    expect(done.detail).toBe("me@example.com");
    expect(done.url).toBeUndefined();
  });

  it("reports a code the CLI rejects", async () => {
    logins = make();
    const login = await logins.start("claude");
    logins.submitCode(login.id, "bad");
    await until(() => logins.get(login.id)?.status === "failed");
    expect(logins.get(login.id)?.error).toBe("OAuth error: invalid code");
  });

  it("finishes Codex's device flow on its own", async () => {
    logins = make();
    const login = await logins.start("codex");
    expect(login).toMatchObject({
      status: "waiting",
      needsCode: false,
      url: "https://auth.openai.com/codex/device",
      userCode: "R7CN-6RVWW",
    });
    await until(() => logins.get(login.id)?.status === "succeeded");
    expect(logins.get(login.id)?.detail).toBe("ChatGPT");
  });

  it("joins the waiting login unless asked to start over", async () => {
    logins = make();
    const first = await logins.start("claude");
    expect((await logins.start("claude")).id).toBe(first.id);
    const fresh = await logins.start("claude", { restart: true });
    expect(fresh.id).not.toBe(first.id);
    expect(logins.get(first.id)?.status).toBe("cancelled");
  });

  it("starts one login for two asks at once", async () => {
    logins = make();
    const [a, b] = await Promise.all([
      logins.start("claude"),
      logins.start("claude"),
    ]);
    expect(b.id).toBe(a.id);
  });

  it("reports the engine's current login, then how it ended", async () => {
    logins = make();
    expect(logins.current("claude")).toBeNull();
    const login = await logins.start("claude");
    expect(logins.current("claude")).toMatchObject({
      id: login.id,
      status: "waiting",
      url: expect.any(String),
    });
    expect(logins.current("codex")).toBeNull();
    logins.cancel(login.id);
    const ended = logins.current("claude");
    expect(ended).toMatchObject({ id: login.id, status: "cancelled" });
    expect(ended?.finishedAt).toEqual(expect.any(String));
    expect(ended?.url).toBeUndefined();
  });

  it("cancels a login and drops its link", async () => {
    logins = make();
    const login = await logins.start("claude");
    expect(logins.cancel(login.id)).toMatchObject({ status: "cancelled" });
    expect(logins.get(login.id)?.url).toBeUndefined();
    expect(logins.submitCode(login.id, "good")?.status).toBe("cancelled");
  });

  it("fails at once when the CLI is not installed", async () => {
    logins = make(null);
    expect(await logins.start("codex")).toMatchObject({
      status: "failed",
      error: "Codex is not installed on this machine.",
    });
  });

  it("fails, with the CLI's own words, when it exits before printing a link", async () => {
    logins = make("fake", { mode: "fail" });
    expect(await logins.start("claude")).toMatchObject({
      status: "failed",
      error: "Error: could not reach the sign-in service",
    });
  });

  it("gives up on a CLI that never prints a link", async () => {
    logins = make("fake", { mode: "silent", linkTimeoutMs: 200 });
    const login = await logins.start("claude");
    expect(login).toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not print a sign-in link"),
    });
  });

  it("never carries the link or code in a failure", async () => {
    logins = make("fake", { mode: "reject-with-link" });
    const login = await logins.start("claude");
    logins.submitCode(login.id, "bad");
    await until(() => logins.get(login.id)?.status === "failed");
    const failed = logins.get(login.id)!;
    expect(failed.url).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain("https://");
    expect(failed.error).toBe("The CLI exited with code 1.");
  });

  it("reads each engine's sign-in status", async () => {
    logins = make();
    expect(await logins.status("claude")).toEqual({
      engine: "claude",
      installed: true,
      signedIn: true,
      detail: "me@example.com",
    });
    expect(await logins.status("codex")).toMatchObject({ signedIn: true });
  });
});

describe("engine login routes", () => {
  const logins = new EngineLogins({ resolveBin: async () => null });
  const app = Fastify();

  beforeAll(async () => {
    await registerEngineLoginRoutes(app, logins);
    await app.ready();
  });
  afterAll(() => app.close());

  it("has no sign-in for other engines", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/system/engines/opencode/login",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("wants a code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/system/engines/logins/nope/code",
      payload: { code: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not know a login it never started", async () => {
    for (const [method, url, payload] of [
      ["GET", "/api/v1/system/engines/logins/nope", undefined],
      ["DELETE", "/api/v1/system/engines/logins/nope", undefined],
      ["POST", "/api/v1/system/engines/logins/nope/code", { code: "x" }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(404);
    }
  });

  it("reports a missing CLI as a failed login", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/system/engines/codex/login",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().login).toMatchObject({ status: "failed" });
  });
});

describe("staged Codex login", () => {
  // `codex login` deletes the sign-in it has as it starts. A login run
  // straight against the real home and then given up signs Codex out.
  let dir: string;
  let real: string;
  let stage: string;
  let fakeCodex: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-codex-stage-"));
    real = path.join(dir, "real-home");
    stage = path.join(dir, "stage");
    mkdirSync(real);
    mkdirSync(stage);
    writeFileSync(path.join(real, "auth.json"), "old sign-in");
    writeFileSync(path.join(real, "config.toml"), "model = 'x'");
    fakeCodex = path.join(dir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/bin/sh
rm -f "$CODEX_HOME/auth.json"
[ -f "$CODEX_HOME/config.toml" ] || exit 9
case "$FAKE_CODEX" in
  ok) echo "new sign-in" > "$CODEX_HOME/auth.json"; exit 0 ;;
  fail) echo "denied" >&2; exit 1 ;;
  quiet) exit 0 ;;
esac
`
    );
    chmodSync(fakeCodex, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (mode: string) => {
    const [bin, ...args] = loginScript(fakeCodex, ["login", "--device-auth"], {
      stageDir: stage,
    });
    return spawnSync(bin!, args, {
      env: { ...process.env, CODEX_HOME: real, FAKE_CODEX: mode },
      encoding: "utf8",
    });
  };

  it("installs the new sign-in only when the login succeeds", () => {
    expect(run("ok").status).toBe(0);
    expect(readFileSync(path.join(real, "auth.json"), "utf8")).toBe(
      "new sign-in\n"
    );
    expect(existsSync(path.join(real, ".auth.json.dispatch"))).toBe(false);
  });

  it("leaves the existing sign-in alone when the login fails", () => {
    const result = run("fail");
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(real, "auth.json"), "utf8")).toBe(
      "old sign-in"
    );
  });

  it("leaves the existing sign-in alone when the CLI ends without one", () => {
    const result = run("quiet");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("finished without signing in");
    expect(readFileSync(path.join(real, "auth.json"), "utf8")).toBe(
      "old sign-in"
    );
  });
});
