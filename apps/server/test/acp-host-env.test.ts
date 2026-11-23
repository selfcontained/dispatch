import { childProcessEnv } from "../src/shared/process/child-environment.js";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchListenerEnv } from "../src/agents/acp/launch-env.js";
import { buildHostEnv, buildLaunchEnv } from "../src/agents/acp/host-env.js";
import {
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { writeLocalHostLaunch } from "../src/agents/acp/local-host-entry.js";
import type { HostLaunch } from "../src/agents/acp/host-protocol.js";
import { loginShellCommand } from "../src/agents/acp/runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("preserves the local ACP launch command and its argument boundaries", () => {
  vi.stubEnv("SHELL", "/bin/zsh");
  try {
    expect(
      loginShellCommand([
        "/local/dispatch",
        "agent-host",
        "--state",
        "/local/state dir",
      ])
    ).toEqual({
      bin: "/bin/zsh",
      args: [
        "-lc",
        '[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; exec "$@"',
        "dispatch-agent-host",
        "/local/dispatch",
        "agent-host",
        "--state",
        "/local/state dir",
      ],
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps the configured PATH behind the workload profile PATH", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dispatch-runner-path-"));
  roots.push(home);
  mkdirSync(path.join(home, ".dispatch"));
  writeFileSync(path.join(home, ".dispatch/env"), "export PATH=/profile/bin\n");
  const command = loginShellCommand(
    ["/usr/bin/printenv", "PATH"],
    "/bin/sh",
    "/fallback with spaces/bin:/usr/bin:/bin"
  );
  expect(
    execFileSync(command.bin, command.args, {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    }).trim()
  ).toBe("/profile/bin:/fallback with spaces/bin:/usr/bin:/bin");
});

it("merges shell-provided trust after ~/.dispatch/env and isolates agents and consumers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-trust-"));
  roots.push(root);
  const local = path.join(root, "local.pem");
  writeFileSync(local, "local installation root");
  const launch = buildLaunchEnv({
    agentId: "test",
    filesDir: root,
    helperBin: "",
    env: launchListenerEnv(
      {
        port: 7000,
        tls: { cert: Buffer.from(""), key: Buffer.from("") },
      },
      {
        TLS_CA: local,
        DISPATCH_LOCAL_TLS: "1",
        CODEX_CA_CERTIFICATE: "/server-only.pem",
      }
    ),
  });
  expect(launch.env.CODEX_CA_CERTIFICATE).toBeUndefined();
  const results: NodeJS.ProcessEnv[] = [];
  for (const agent of ["one", "two"]) {
    const home = path.join(root, agent);
    mkdirSync(path.join(home, ".dispatch"), { recursive: true });
    const overrides: string[] = [];
    for (const variable of [
      "CODEX_CA_CERTIFICATE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ]) {
      const file = path.join(home, `${variable}.pem`);
      writeFileSync(file, `${agent} ${variable} corporate root`);
      overrides.push(`export ${variable}='${file}'`);
    }
    writeFileSync(path.join(home, ".dispatch/env"), overrides.join("\n"));
    const command = loginShellCommand(["/usr/bin/env"], "/bin/sh");
    const shellEnv = Object.fromEntries(
      execFileSync(command.bin, command.args, {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        })
    );
    const env = buildHostEnv({ ...launch, engine: "codex" }, home, shellEnv);
    results.push(env);
    expect(env.DISPATCH_LOCAL_CA_CERTIFICATE).toBeUndefined();
    for (const variable of [
      "CODEX_CA_CERTIFICATE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      const bundle = readFileSync(env[variable]!, "utf8");
      expect(bundle).toContain("local installation root");
      expect(bundle).toContain(`${agent} ${variable} corporate root`);
      expect(bundle).not.toContain(`${agent} SSL_CERT_FILE corporate root`);
      expect(bundle.match(/BEGIN CERTIFICATE/g)!.length).toBeGreaterThan(10);
    }
    const fallback = buildHostEnv({ ...launch, engine: "codex" }, home, {
      ...shellEnv,
      CODEX_CA_CERTIFICATE: undefined,
      CURL_CA_BUNDLE: undefined,
      NODE_EXTRA_CA_CERTS: undefined,
    });
    expect(readFileSync(fallback.CODEX_CA_CERTIFICATE!, "utf8")).toContain(
      `${agent} SSL_CERT_FILE corporate root`
    );
    expect(readFileSync(fallback.CURL_CA_BUNDLE!, "utf8")).toContain(
      `${agent} SSL_CERT_FILE corporate root`
    );
    expect(readFileSync(fallback.NODE_EXTRA_CA_CERTS!, "utf8")).toContain(
      `${agent} SSL_CERT_FILE corporate root`
    );
  }
  expect(results[0].CODEX_CA_CERTIFICATE).not.toBe(
    results[1].CODEX_CA_CERTIFICATE
  );
  expect(readFileSync(results[0].NODE_EXTRA_CA_CERTS!, "utf8")).not.toContain(
    "two NODE_EXTRA_CA_CERTS corporate root"
  );
});

it("preserves the shell trust configuration without managed local TLS", () => {
  const env = buildHostEnv(
    { env: {}, engine: "claude", pathPrefix: [] },
    "/unused",
    {
      CODEX_CA_CERTIFICATE: "corp.pem",
      CURL_CA_BUNDLE: "curl.pem",
      NODE_EXTRA_CA_CERTS: "node.pem",
    }
  );
  expect(env.CODEX_CA_CERTIFICATE).toBe("corp.pem");
  expect(env.CURL_CA_BUNDLE).toBe("curl.pem");
  expect(env.NODE_EXTRA_CA_CERTS).toBe("node.pem");
});

describe("ACP host environment", () => {
  it("withholds the adapter command, server settings and credentials", () => {
    expect(
      childProcessEnv({
        PATH: "/usr/bin",
        DISPATCH_ACP_ADAPTER_COMMAND: '["/tmp/fake-acp-agent"]',
        DISPATCH_AGENT_HOST_COMMAND: '["/tmp/host"]',
        DISPATCH_FILES_ROOT: "/tmp/dispatch-files",
        DATABASE_URL: "postgres://secret",
        ANTHROPIC_API_KEY: "secret",
      })
    ).toEqual({ PATH: "/usr/bin" });
  });
});

it("lets an engine CLI found off PATH run the node installed beside it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-path-"));
  roots.push(root);
  // An nvm layout: `codex` is a script whose interpreter is only in its own dir.
  const bin = path.join(root, ".nvm/versions/node/v23.7.0/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "fakenode"), "#!/bin/sh\necho ran\n", {
    mode: 0o755,
  });
  const codex = path.join(bin, "codex");
  writeFileSync(codex, "#!/usr/bin/env fakenode\n", { mode: 0o755 });
  const env = buildHostEnv(
    {
      env: {},
      engine: "codex",
      pathPrefix: ["/dispatch/bin"],
      bins: { claudeBin: "/elsewhere/claude", codexBin: codex },
    },
    root,
    { HOME: root, PATH: "/usr/bin:/bin" }
  );
  expect(env.PATH?.split(path.delimiter).slice(0, 4)).toEqual([
    "/dispatch/bin",
    "/usr/bin",
    "/bin",
    bin,
  ]);
  expect(execFileSync(codex, { env, encoding: "utf8" }).trim()).toBe("ran");
});

for (const engine of ["claude", "codex", "opencode"] as const) {
  it(`${engine} can launch an npx MCP command with Node outside the login PATH`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-mcp-path-"));
    roots.push(root);
    const localBin = path.join(root, ".local/bin");
    const bin = path.join(root, ".nvm/versions/node/v22.22.1/bin");
    const oldBin = path.join(root, ".nvm/versions/node/v9.9.9/bin");
    for (const dir of [localBin, bin, oldBin])
      mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(bin, "node"),
      '#!/bin/sh\nprintf "mcp-started\\n"\n',
      { mode: 0o755 }
    );
    writeFileSync(
      path.join(oldBin, "node"),
      '#!/bin/sh\nprintf "selected-old-node\\n"\n',
      { mode: 0o755 }
    );
    // Like real npx, the command needs both executable lookup and its Node shebang.
    writeFileSync(path.join(bin, "npx"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    });
    const inherited = { HOME: root, PATH: "/usr/bin:/bin", KEEP: "unchanged" };
    const launch = {
      env: {},
      engine,
      pathPrefix: ["/dispatch/bin", localBin],
      bins: {
        claudeBin: path.join(localBin, "claude"),
        codexBin: path.join(localBin, "codex"),
        opencodeBin: path.join(localBin, "opencode"),
      },
    };
    const env = buildHostEnv(launch, root, inherited);
    expect(
      execFileSync("npx", ["@playwright/mcp"], { env, encoding: "utf8" }).trim()
    ).toBe("mcp-started");
    expect(env.KEEP).toBe("unchanged");
    expect(inherited.PATH).toBe("/usr/bin:/bin");
    const selected = buildHostEnv(launch, root, {
      ...inherited,
      PATH: `${oldBin}:/usr/bin:/bin`,
    });
    expect(
      execFileSync("npx", [], { env: selected, encoding: "utf8" }).trim()
    ).toBe("selected-old-node");
    expect(new Set(env.PATH!.split(path.delimiter)).size).toBe(
      env.PATH!.split(path.delimiter).length
    );
  });
}

it("preserves CLI effort defaults unless the launch explicitly overrides them", () => {
  const shell = { CLAUDE_EFFORT: "low", CLAUDE_CODE_EFFORT_LEVEL: "low" };
  const launch = { env: {}, pathPrefix: [], engine: "claude" as const };
  expect(buildHostEnv(launch, "/tmp/effort-env", shell)).toMatchObject(shell);
  const overridden = buildHostEnv(
    { ...launch, effort: "high" },
    "/tmp/effort-env",
    shell
  );
  expect(overridden.CLAUDE_EFFORT).toBeUndefined();
  expect(overridden.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
});

for (const engine of ["claude", "codex", "opencode"] as const) {
  it(`preserves the ${engine} local launch environment`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-launch-golden-"));
    roots.push(root);
    const bins = {
      claudeBin: path.join(root, "tools/claude/bin/claude"),
      codexBin: path.join(root, "tools/codex/bin/codex"),
      opencodeBin: path.join(root, "tools/opencode/bin/opencode"),
    };
    for (const bin of Object.values(bins)) {
      mkdirSync(path.dirname(bin), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    }
    const shellEnv = {
      HOME: "/dispatch-golden/home",
      PATH: "/shell/bin:/usr/bin:/bin",
      DISPATCH_ACP_ADAPTER_COMMAND: '["fixture"]',
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      CUSTOM_SHELL_SETTING: "kept",
    };
    vi.stubEnv("HOME", shellEnv.HOME);
    vi.stubEnv(
      "DISPATCH_LOCAL_RUNNER_LAUNCH",
      JSON.stringify({
        filesRoot: path.join(root, "files"),
        helperBin: "/dispatch/bin",
        env: launchListenerEnv({ port: 6767, tls: null }),
        bins,
      })
    );
    try {
      await writeLocalHostLaunch(root, {
        session: sessionFromWire("agt_golden"),
        launchId: "golden",
        directory: pathFromWire(root),
        engine,
        model: null,
        effort: "medium",
        access: "full",
        resume: null,
        systemText: null,
        firstText: null,
        overflowNotice: null,
        env: {},
        mcp: [],
        owner: null,
      });
      const launch: HostLaunch = JSON.parse(
        readFileSync(path.join(root, "launch.json"), "utf8")
      );
      const env = buildHostEnv(launch, root, shellEnv);
      expect({
        ...env,
        DISPATCH_FILES_DIR: env.DISPATCH_FILES_DIR?.replace(
          root,
          "/dispatch-golden"
        ),
        PATH: env.PATH?.replace(`${root}/tools`, "/tools"),
      }).toMatchSnapshot();
    } finally {
      vi.unstubAllEnvs();
    }
  });
}
