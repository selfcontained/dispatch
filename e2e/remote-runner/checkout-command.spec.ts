import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHeaders, deleteAgentViaAPI } from "../helpers";
import {
  enrollViaUi,
  guest,
  guestDiagnostics,
  RUNNERS_API,
  state,
} from "./harness";

function manifest(marker: string, hookCode = 0) {
  return JSON.stringify({
    tools: [
      {
        name: "fixture",
        description: marker,
        command: [
          "sh",
          "-c",
          'printf "%s|%s|%s|%s|%s" "$1" "$PWD" "$(id -u):$(id -g)" "$DISPATCH_AGENT_ID" "$3"',
          "fixture",
          marker,
        ],
        params: [
          {
            name: "value",
            type: "string",
            flag: "--value",
            description: "Fixture value",
          },
        ],
      },
      {
        name: "large",
        description: "Return more output than the legacy runner limit.",
        command: ["sh", "-c", "yes x | head -c 70000; exit 17"],
      },
    ],
    hooks: {
      stop: {
        command: [
          "sh",
          "-c",
          'printf "%s|%s|%s\\n" "$PWD" "$(id -u):$(id -g)" "$DISPATCH_AGENT_ID" >> hook.log; exit "$1"',
          "hook",
          String(hookCode),
        ],
      },
    },
  });
}

function seedGuest(
  name: "alpha" | "scratch",
  directory: string,
  marker: string,
  hookCode = 0
) {
  guest(
    name,
    `mkdir -p '${directory}/.dispatch' && cat > '${directory}/.dispatch/tools.json' <<'MANIFEST'\n${manifest(marker, hookCode)}\nMANIFEST\nchown -R 1500:1500 '${directory}'`
  );
}

async function mcp(
  request: APIRequestContext,
  id: string,
  token: string | undefined,
  method: string,
  params?: unknown
) {
  return request.post("/api/mcp/" + id, {
    headers: {
      Accept: "application/json, text/event-stream",
      ...(token && { Authorization: "Bearer " + token }),
    },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function result(response: Awaited<ReturnType<typeof mcp>>) {
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  const line = body.split("\n").find((line) => line.startsWith("data: "));
  expect(line, body).toBeDefined();
  return JSON.parse(line!.slice(6)).result;
}

test("dispatches authenticated repo tools and stop hooks to the bound checkout", async ({
  page,
  request,
}, testInfo) => {
  const native = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "dispatch-checkout-command-"))
  );
  const agents: string[] = [];
  const start = async (cwd: string) => {
    const res = await request.post("/api/v1/agents", {
      headers: authHeaders(),
      data: {
        name: "Checkout command fixture",
        type: "claude",
        cwd,
        useWorktree: false,
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const {
      agent: { id },
    } = await res.json();
    agents.push(id);
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/v1/agents/" + id, {
            headers: authHeaders(),
          });
          return (await response.json()).agent?.status;
        },
        { timeout: 30_000 }
      )
      .toBe("running");
    return id as string;
  };
  const stop = async (id: string) => {
    const res = await request.post("/api/v1/agents/" + id + "/stop", {
      headers: authHeaders(),
    });
    expect(res.ok(), await res.text()).toBe(true);
    expect((await res.json()).agent.status).toBe("stopped");
  };
  const token = (runner: "alpha" | "scratch", id: string): string =>
    JSON.parse(guest(runner, `cat /var/lib/runner/hosts/${id}/launch.json`)).mcp
      .token;
  const call = {
    name: "repo_fixture",
    arguments: { value: "literal ; $HOME" },
  };
  const verify = async (
    id: string,
    key: string | undefined,
    marker: string,
    cwd: string,
    identity: string
  ) => {
    const catalog = await result(await mcp(request, id, key, "tools/list"));
    expect(catalog.tools).toContainEqual(
      expect.objectContaining({ name: "repo_fixture", description: marker })
    );
    const invoked = await result(
      await mcp(request, id, key, "tools/call", call)
    );
    expect(invoked.structuredContent).toMatchObject({
      exitCode: 0,
      stdout: [marker, cwd, identity, id, call.arguments.value].join("|"),
    });
    await testInfo.attach(marker, {
      body: invoked.structuredContent.stdout,
      contentType: "text/plain",
    });
  };

  try {
    const alpha = await enrollViaUi(page, request, "alpha");
    const configured = state.runners.alpha.workspaceDir;
    seedGuest("alpha", configured, "configured");
    const configuredId = await start(`runner://${alpha}/${state.workspace}`);
    const configuredToken = token("alpha", configuredId);
    await verify(
      configuredId,
      configuredToken,
      "configured",
      configured,
      "1500:1500"
    );

    const scratch = await enrollViaUi(page, request, "scratch");
    const managedId = await start(`runner://${scratch}/@session`);
    const managed = `/var/lib/runner/sessions/${managedId}`;
    seedGuest("scratch", managed, "managed", 23);
    const managedToken = token("scratch", managedId);
    await verify(managedId, managedToken, "managed", managed, "1500:1500");
    expect(
      (
        await mcp(request, managedId, configuredToken, "tools/call", call)
      ).status()
    ).toBe(403);
    expect(
      await result(await mcp(request, managedId, undefined, "tools/call", call))
    ).toMatchObject({ isError: true });

    const moved = "/tmp/checkout-command-moved";
    seedGuest("scratch", moved, "moved");
    for (let repeat = 0; repeat < 2; repeat++) {
      const res = await request.patch(`/api/v1/agents/${managedId}/workspace`, {
        headers: authHeaders(),
        data: { path: moved },
      });
      expect(res.ok(), await res.text()).toBe(true);
      expect((await res.json()).agent.workspacePath).toBe(moved);
    }
    await verify(managedId, managedToken, "moved", moved, "1500:1500");
    const invokeMoved = (name: string) =>
      mcp(request, managedId, managedToken, "tools/call", {
        name,
        arguments: {},
      }).then(result);
    const large = await invokeMoved("repo_large");
    expect(large.structuredContent).toMatchObject({ exitCode: 17 });
    expect(large.structuredContent.truncated).toBeUndefined();
    expect(Buffer.byteLength(large.structuredContent.stdout) > 64 * 1024).toBe(
      true
    );
    await stop(managedId);
    await stop(managedId);
    for (const dir of [managed, moved]) {
      expect(guest("scratch", `cat '${dir}/hook.log'`).trim()).toBe(
        `${dir}|1500:1500|${managedId}`
      );
    }
    await stop(configuredId);
    expect(guest("alpha", `cat '${configured}/hook.log'`).trim()).toBe(
      `${configured}|1500:1500|${configuredId}`
    );

    mkdirSync(path.join(native, ".dispatch"));
    writeFileSync(
      path.join(native, ".dispatch/tools.json"),
      manifest("native", 23)
    );
    const localId = await start(native);
    await verify(
      localId,
      undefined,
      "native",
      native,
      `${process.getuid!()}:${process.getgid!()}`
    );

    const nativeMoved = path.join(native, "moved");
    mkdirSync(path.join(nativeMoved, ".dispatch"), { recursive: true });
    writeFileSync(
      path.join(nativeMoved, ".dispatch/tools.json"),
      manifest("native moved")
    );
    const selected = await request.patch(
      `/api/v1/agents/${localId}/workspace`,
      {
        headers: authHeaders(),
        data: { path: nativeMoved },
      }
    );
    expect(selected.ok(), await selected.text()).toBe(true);
    const nativeIdentity = `${process.getuid!()}:${process.getgid!()}`;
    await verify(
      localId,
      undefined,
      "native moved",
      nativeMoved,
      nativeIdentity
    );

    const nativeHook = (dir: string) => `${dir}|${nativeIdentity}|${localId}\n`;
    await stop(localId);
    await stop(localId);
    for (const dir of [native, nativeMoved])
      expect(readFileSync(path.join(dir, "hook.log"), "utf8")).toBe(
        nativeHook(dir)
      );

    const restarted = await request.post(`/api/v1/agents/${localId}/start`, {
      headers: authHeaders(),
    });
    expect(restarted.ok(), await restarted.text()).toBe(true);
    const archive = await request.delete(
      `/api/v1/agents/${localId}?force=true&cleanupWorktree=keep`,
      { headers: authHeaders() }
    );
    expect(archive.ok(), await archive.text()).toBe(true);
    await expect
      .poll(async () =>
        (
          await request.get(`/api/v1/agents/${localId}`, {
            headers: authHeaders(),
          })
        ).status()
      )
      .toBe(404);
    agents.splice(agents.indexOf(localId), 1);
    for (const dir of [native, nativeMoved])
      expect(readFileSync(path.join(dir, "hook.log"), "utf8")).toBe(
        nativeHook(dir).repeat(2)
      );

    const revoked = await request.delete(`${RUNNERS_API}/${alpha}`, {
      headers: authHeaders(),
    });
    expect(revoked.ok(), await revoked.text()).toBe(true);
    expect(
      (
        await mcp(request, configuredId, configuredToken, "tools/call", call)
      ).status()
    ).toBe(403);
  } catch (error) {
    for (const name of ["alpha", "scratch"] as const) {
      await testInfo.attach(name + " runner diagnostics", {
        body: guestDiagnostics(name),
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    for (const id of agents.reverse()) await deleteAgentViaAPI(request, id);
    rmSync(native, { recursive: true, force: true });
  }
});
