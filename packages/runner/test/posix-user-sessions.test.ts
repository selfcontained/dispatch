/*
 * The `posix-user` session ports and the local runner's session family over
 * real files, processes and sockets: the records older builds write are the
 * records read, hosts are identified as older builds identify them, and the
 * attach channel carries a host's frames as contract messages.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { createSessionCore } from "../src/core/sessions.js";
import { localSessionHandlers } from "../src/local/sessions.js";
import {
  hostCommandFor,
  inspectHostDir,
  posixUserLayout,
  posixUserProcesses,
  posixUserState,
  type PosixHostEntry,
} from "../src/platform/posix-user/sessions.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run();
});

/** Short: host sockets must fit macOS's 104-byte limit. */
function root() {
  const dir = mkdtempSync("/tmp/pu-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const until = async (check: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A process whose command line ends like a host's for `dir`. */
function fakeHost(dir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1e9)", "agent-host", "--state", dir],
    { stdio: "ignore", env: { ...process.env, ...extraEnv } }
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  return child;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function entry(cleaned: string[] = []): PosixHostEntry {
  return {
    command: () => [process.execPath, "-e", "setInterval(() => {}, 1e9)"],
    wrap: (command) => ({ bin: command[0]!, args: command.slice(1) }),
    env: () => ({ PATH: process.env.PATH }),
    ownership: {
      create: (env) => {
        const marker = `TEST_OWNED_${Math.random().toString(16).slice(2)}=1`;
        const [key, value] = marker.split("=");
        return { marker, env: { ...env, [key!]: value } };
      },
      cleanup: (marker) => {
        cleaned.push(marker);
      },
    },
  };
}

describe("posix-user layout and records", () => {
  it("names the files every build reads and tracks directories with a host record", async () => {
    const dir = root();
    const layout = posixUserLayout(dir);
    expect(layout.hostDir("agt_1")).toBe(join(dir, "agt_1"));
    expect(layout.socket("agt_1")).toBe(join(dir, "agt_1", "host.sock"));
    expect(layout.identityFile("agt_1")).toBe(join(dir, "agt_1", "ownership"));
    expect(layout.logFile("agt_1")).toBe(join(dir, "agt_1", "host.log"));
    expect(() => layout.hostDir("..")).toThrow();
    expect(() => layout.hostDir("a/b")).toThrow();

    for (const [key, file] of [
      ["agt_owned", "ownership"],
      ["agt_pid", "host.pid"],
      ["agt_launch_only", "launch.json"],
    ]) {
      mkdirSync(join(dir, key!));
      writeFileSync(join(dir, key!, file!), "x");
    }
    writeFileSync(join(dir, "stray-file"), "x");
    expect(await layout.trackedKeys()).toEqual(["agt_owned", "agt_pid"]);
  });

  it("keeps the record as the bare marker older builds write and read", async () => {
    const dir = root();
    const layout = posixUserLayout(dir);
    const processes = posixUserProcesses(layout, entry());
    const identity = processes.parseIdentity(
      "DISPATCH_OWNED_0123456789abcdef0123456789abcdef=1\n",
      "agt_1"
    );
    expect(identity).toEqual({
      marker: "DISPATCH_OWNED_0123456789abcdef0123456789abcdef=1",
      dir: join(dir, "agt_1"),
    });
    expect(processes.formatIdentity!(identity, { extra: 1 })).toBe(
      identity.marker
    );
    expect(() => processes.parseIdentity("", "agt_1")).toThrow();
    expect(() => processes.parseIdentity("a b", "agt_1")).toThrow();

    const file = layout.identityFile("agt_1");
    await posixUserState.write(file, identity.marker);
    expect(readFileSync(file, "utf8")).toBe(identity.marker);
    const handle = await posixUserState.openPrivate(file);
    expect(await handle!.trusted()).toBe(true);
    await handle!.close();
  });
});

describe("posix-user host identity", () => {
  it("reads a host directory as older builds do: gone, stale, or live", async () => {
    const dir = join(root(), "agt_1");
    mkdirSync(dir);
    expect(await inspectHostDir(dir)).toEqual({ state: "gone", pid: null });
    writeFileSync(join(dir, "host.pid"), "not-a-pid\n");
    expect((await inspectHostDir(dir)).state).toBe("stale");
    // A foreign live process under the recorded pid is not the host.
    writeFileSync(join(dir, "host.pid"), `${process.pid}\n`);
    expect((await inspectHostDir(dir)).state).toBe("stale");
    const exited = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => exited.once("exit", resolve));
    writeFileSync(join(dir, "host.pid"), `${exited.pid}\n`);
    expect((await inspectHostDir(dir)).state).toBe("gone");

    const host = fakeHost(dir);
    writeFileSync(join(dir, "host.pid"), `${host.pid}\n`);
    await until(() => !!host.pid);
    expect(await inspectHostDir(dir)).toEqual({ state: "live", pid: host.pid });
    // The same command for another directory is another host.
    const other = join(dir, "..", "agt_2");
    mkdirSync(other);
    writeFileSync(join(other, "host.pid"), `${host.pid}\n`);
    expect((await inspectHostDir(other)).state).toBe("stale");
  });

  it("spawns with the marker recorded before the process exists, then stops and cleans up", async () => {
    const dir = root();
    const layout = posixUserLayout(dir);
    const cleaned: string[] = [];
    const hostEntry = entry(cleaned);
    const core = createSessionCore({
      processes: posixUserProcesses(layout, hostEntry),
      layout,
      state: posixUserState,
      sweepMs: null,
    });
    cleanups.push(() => core.close());
    const key = "agt_spawned";
    mkdirSync(layout.hostDir(key));
    // The host script records whether the marker file was there at start.
    const script = join(dir, "host.mjs");
    writeFileSync(
      script,
      `import {existsSync, writeFileSync} from "node:fs";
       const dir = process.argv.at(-1);
       writeFileSync(dir + "/saw-ownership", String(existsSync(dir + "/ownership")));
       writeFileSync(dir + "/host.pid", process.pid + "\\n");
       setInterval(() => {}, 1e9);`
    );
    const command = hostCommandFor(
      { ...hostEntry, command: () => [process.execPath, script, "agent-host"] },
      layout.hostDir(key)
    );
    await core.lock(key, () =>
      core.spawn(key, () => command, dir, hostEntry.env(), {})
    );
    const marker = readFileSync(layout.identityFile(key), "utf8");
    expect(marker).toMatch(/^TEST_OWNED_[0-9a-f]+=1$/);
    await until(() => existsSync(join(layout.hostDir(key), "host.pid")));
    expect(
      readFileSync(join(layout.hostDir(key), "saw-ownership"), "utf8")
    ).toBe("true");
    const pid = Number(
      readFileSync(join(layout.hostDir(key), "host.pid"), "utf8")
    );
    expect(await core.lock(key, () => core.alive(key))).toBe(true);
    cleanups.push(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });

    await core.lock(key, () => core.stop(key, true));
    await until(() => !alive(pid));
    expect(cleaned).toContain(marker);
    for (const name of ["ownership", "host.pid", "host.sock"])
      expect(existsSync(join(layout.hostDir(key), name))).toBe(false);
  });
});

/** A v1 host on `socket` that answers hello and echoes client frames. */
async function v1Host(socket: string, agentId: string) {
  const received: unknown[] = [];
  const connections: Socket[] = [];
  const server: Server = createServer((connection) => {
    connections.push(connection);
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        received.push(message);
        if (message.type === "hello")
          connection.write(
            [
              {
                type: "welcome",
                agentId,
                sessionId: "s1",
                running: true,
                journalSeq: 1,
                journalId: "j1",
              },
              "",
              "not json",
              {
                type: "event",
                seq: 1,
                at: "now",
                event: { type: "turn", agentId, state: "settled" },
              },
              {
                type: "mcp_inventory_result",
                id: "inv-other",
                result: { agentId: "agt_other", status: "ok", inventory: null },
              },
              {
                type: "mcp_inventory_result",
                id: "inv-own",
                result: { agentId, status: "ok", inventory: null },
              },
            ]
              .map((frame) =>
                typeof frame === "string" ? frame : JSON.stringify(frame)
              )
              .join("\n") + "\n"
          );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(() => {
    for (const connection of connections) connection.destroy();
    server.close();
  });
  return { received, connections };
}

function lines(channel: NodeJS.ReadableStream, count: number) {
  return new Promise<Record<string, unknown>[]>((resolve) => {
    const frames: Record<string, unknown>[] = [];
    let buffer = "";
    channel.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (frames.length === count) resolve(frames);
      }
    });
  });
}

const context = { receiveBlob: () => Promise.resolve(), emit: () => {} };

describe("the local runner's session family", () => {
  it("attaches by dialling the host, decoding its frames without the agent id", async () => {
    const dir = root();
    const key = "agt_attach";
    mkdirSync(join(dir, key));
    const host = await v1Host(join(dir, key, "host.sock"), key);
    const handlers = localSessionHandlers({ root: dir, entry: entry() });
    cleanups.push(() => handlers.stop());
    const { info, channel } = await handlers.opens!["session.attach"]!(
      { session: sessionFromWire(key) },
      context
    );
    expect(info).toEqual({});
    const received = lines(channel, 4);
    channel.write(
      JSON.stringify({ type: "hello", fromSeq: 0, journalId: null }) + "\n"
    );
    const frames = await received;
    expect(frames.map((frame) => frame.type)).toEqual([
      "welcome",
      "event",
      "error",
      "mcp_inventory_result",
    ]);
    expect(JSON.stringify(frames)).not.toContain(key);
    expect(frames[2]).toMatchObject({ id: "inv-other" });
    expect(frames[3]).toMatchObject({
      id: "inv-own",
      result: { status: "ok" },
    });
    // The client's frames reach the host as written.
    expect(host.received).toEqual([
      { type: "hello", fromSeq: 0, journalId: null },
    ]);
    // Closing the channel closes the host connection.
    channel.destroy();
    await until(() => host.connections.every((socket) => socket.destroyed));
  });

  it("refuses a session no build recorded as gone, and a recorded host that does not answer as an ordinary failure", async () => {
    const dir = root();
    const handlers = localSessionHandlers({ root: dir, entry: entry() });
    cleanups.push(() => handlers.stop());
    const attach = (key: string) =>
      handlers.opens!["session.attach"]!(
        { session: sessionFromWire(key) },
        context
      );
    await expect(attach("agt_never")).rejects.toMatchObject({
      code: "host_gone",
    });
    mkdirSync(join(dir, "agt_dead"));
    writeFileSync(join(dir, "agt_dead", "ownership"), "TEST_OWNED_1=1");
    const failure = await attach("agt_dead").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RunnerCallError);
    await expect(attach("..")).rejects.toMatchObject({ code: "invalid" });
  });

  it("answers alive, logs and list from the records, without touching them", async () => {
    const dir = root();
    const handlers = localSessionHandlers({ root: dir, entry: entry() });
    cleanups.push(() => handlers.stop());
    const live = join(dir, "agt_live");
    const stale = join(dir, "agt_stale");
    mkdirSync(live);
    mkdirSync(stale);
    const host: ChildProcess = fakeHost(live);
    await until(() => !!host.pid);
    writeFileSync(join(live, "host.pid"), `${host.pid}\n`);
    writeFileSync(join(live, "ownership"), "TEST_OWNED_live=1");
    writeFileSync(
      join(live, "host.log"),
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n"
    );
    // A stale record: a live process that is not this directory's host.
    const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"]);
    cleanups.push(() => {
      foreign.kill("SIGKILL");
    });
    await until(() => !!foreign.pid);
    writeFileSync(join(stale, "host.pid"), `${foreign.pid}\n`);
    writeFileSync(join(stale, "ownership"), "TEST_OWNED_stale=1");

    const call = handlers.calls as Record<
      string,
      (input: unknown, ctx: typeof context) => Promise<unknown>
    >;
    expect(
      await call["session.alive"]!(
        { session: sessionFromWire("agt_live") },
        context
      )
    ).toEqual({ state: "live" });
    expect(
      await call["session.alive"]!(
        { session: sessionFromWire("agt_stale") },
        context
      )
    ).toEqual({ state: "stale" });
    expect(
      await call["session.logs"]!(
        { session: sessionFromWire("agt_live"), lines: 2 },
        context
      )
    ).toEqual({ text: "line 28\nline 29" });
    await expect(
      call["session.logs"]!(
        { session: sessionFromWire("agt_none"), lines: 2 },
        context
      )
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await call["session.list"]!({ owner: null }, context)).toEqual({
      sessions: [
        { session: "agt_live", state: "live" },
        { session: "agt_stale", state: "stale" },
      ],
    });
    // Nothing killed, nothing removed.
    expect(alive(foreign.pid!)).toBe(true);
    expect(alive(host.pid!)).toBe(true);
    for (const file of [
      join(stale, "host.pid"),
      join(stale, "ownership"),
      join(live, "ownership"),
    ])
      expect(existsSync(file)).toBe(true);
  });
});
