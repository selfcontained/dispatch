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
import { afterEach, describe, expect, it } from "vitest";
import { buildLaunchEnv } from "../src/agents/acp/launch-env.js";
import { buildHostEnv } from "../src/agents/acp/host-env.js";
import {
  hostProcessEnv,
  loginShellCommand,
} from "../src/agents/acp/runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("merges shell-provided trust after ~/.dispatch/env and isolates agents and consumers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dispatch-host-trust-"));
  roots.push(root);
  const local = path.join(root, "local.pem");
  writeFileSync(local, "local installation root");
  const launch = buildLaunchEnv({
    agentId: "test",
    role: "standard",
    filesDir: root,
    engine: "codex",
    config: {
      port: 7000,
      tls: { cert: Buffer.from(""), key: Buffer.from("") },
      dispatchBinDir: "",
      authToken: "test",
    },
    base: {
      TLS_CA: local,
      DISPATCH_LOCAL_TLS: "1",
      CODEX_CA_CERTIFICATE: "/server-only.pem",
    },
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
    });
    expect(readFileSync(fallback.CODEX_CA_CERTIFICATE!, "utf8")).toContain(
      `${agent} SSL_CERT_FILE corporate root`
    );
    expect(readFileSync(fallback.CURL_CA_BUNDLE!, "utf8")).toContain(
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
  it("passes the fake adapter command while withholding server settings and credentials", () => {
    expect(
      hostProcessEnv({
        PATH: "/usr/bin",
        DISPATCH_ACP_ADAPTER_COMMAND: '["/tmp/fake-acp-agent"]',
        DISPATCH_AGENT_HOST_COMMAND: '["/tmp/host"]',
        DISPATCH_FILES_ROOT: "/tmp/dispatch-files",
        DATABASE_URL: "postgres://secret",
        ANTHROPIC_API_KEY: "secret",
      })
    ).toEqual({
      PATH: "/usr/bin",
      DISPATCH_ACP_ADAPTER_COMMAND: '["/tmp/fake-acp-agent"]',
    });
  });
});
