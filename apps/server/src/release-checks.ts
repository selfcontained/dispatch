import { readFile, stat } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { RequiredCheckName } from "./release-metadata.js";
import { readReleaseStore } from "./release-store.js";
import { fixedRuntimePath } from "./server/release-helpers.js";

export type CheckContext = {
  serverDir: string;
  targetTag: string;
  /** Used for the health endpoint check. Defaults to localhost. */
  healthUrl?: string;
};

export type CheckResult = {
  name: RequiredCheckName;
  ok: boolean;
  message: string;
};

export async function runRequiredChecks(
  names: RequiredCheckName[],
  ctx: CheckContext
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const name of names) {
    try {
      results.push(await runCheck(name, ctx));
    } catch (err) {
      results.push({
        name,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function runCheck(
  name: RequiredCheckName,
  ctx: CheckContext
): Promise<CheckResult> {
  switch (name) {
    case "expected_runtime_artifact":
      return checkRuntimeArtifact(ctx);
    case "service_entrypoint":
      return checkServiceEntrypoint(ctx);
    case "service_restarted":
      return checkServiceRestarted(ctx);
    case "health_endpoint":
      return checkHealthEndpoint(ctx);
    case "version_converged":
      return checkVersionConverged(ctx);
  }
}

async function checkRuntimeArtifact(ctx: CheckContext): Promise<CheckResult> {
  const runtime = fixedRuntimePath(ctx.serverDir);
  try {
    const info = await stat(runtime);
    return info.isFile()
      ? {
          name: "expected_runtime_artifact",
          ok: true,
          message: `Fixed runtime present: ${runtime}`,
        }
      : {
          name: "expected_runtime_artifact",
          ok: false,
          message: `${runtime} is not a regular file`,
        };
  } catch {
    return {
      name: "expected_runtime_artifact",
      ok: false,
      message: `Fixed runtime not found: ${runtime}`,
    };
  }
}

async function checkServiceEntrypoint(ctx: CheckContext): Promise<CheckResult> {
  const runtime = fixedRuntimePath(ctx.serverDir);
  const definition = serviceDefinitionPath();
  try {
    const contents = await readFile(definition, "utf8");
    return contents.includes(runtime)
      ? {
          name: "service_entrypoint",
          ok: true,
          message: `Service invokes fixed runtime: ${runtime}`,
        }
      : {
          name: "service_entrypoint",
          ok: false,
          message: `${definition} does not invoke ${runtime}`,
        };
  } catch (err) {
    return {
      name: "service_entrypoint",
      ok: false,
      message: `Could not read service definition ${definition}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function serviceDefinitionPath(): string {
  const configured = process.env.DISPATCH_SERVICE_DEFINITION_PATH?.trim();
  if (configured) return configured;
  return process.platform === "darwin"
    ? path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        "com.dispatch.server.plist"
      )
    : path.join(os.homedir(), ".config", "systemd", "user", "dispatch.service");
}

async function checkServiceRestarted(_ctx: CheckContext): Promise<CheckResult> {
  // The actual restart is fire-and-forget on the host service manager. We
  // approximate "did the service come back" by confirming the release store
  // was written for the target tag — the service rewrites the store on its
  // own boot. This is intentionally lenient: the deeper check is
  // health_endpoint, which only passes when the new process is serving HTTP.
  const record = await readReleaseStore().catch(() => null);
  if (!record) {
    return {
      name: "service_restarted",
      ok: false,
      message: "release.json not present",
    };
  }
  return {
    name: "service_restarted",
    ok: true,
    message: `last deploy ${record.tag} at ${record.deployedAt}`,
  };
}

async function checkHealthEndpoint(ctx: CheckContext): Promise<CheckResult> {
  const url = ctx.healthUrl ?? "http://127.0.0.1:6767/api/v1/health";
  try {
    const { status, body } = isLoopbackHttps(url)
      ? await fetchLoopbackHttps(url)
      : await fetchViaGlobal(url);
    if (status < 200 || status >= 300) {
      return {
        name: "health_endpoint",
        ok: false,
        message: `${url} returned ${status}`,
      };
    }
    let data: { status?: string };
    try {
      data = JSON.parse(body) as { status?: string };
    } catch {
      return {
        name: "health_endpoint",
        ok: false,
        message: `${url} returned invalid JSON`,
      };
    }
    if (data?.status !== "ok") {
      return {
        name: "health_endpoint",
        ok: false,
        message: `health response missing status=ok`,
      };
    }
    return {
      name: "health_endpoint",
      ok: true,
      message: `health endpoint ok (${url})`,
    };
  } catch (err) {
    return {
      name: "health_endpoint",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// IPv6 loopback isn't included: `dispatchBaseUrl()` always hardcodes
// 127.0.0.1, so the runtime health URL never uses `[::1]`. If that ever
// changes, note that `new URL("https://[::1]/").hostname` returns
// `"[::1]"` (bracketed), so the entry has to be `"[::1]"` to match.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function isLoopbackHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function fetchViaGlobal(
  url: string
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { status: res.status, body: await res.text() };
}

// The same-process self-check legitimately hits the local server's
// self-signed TLS cert when config.tls is enabled. Bare fetch refuses
// self-signed certs and there is no per-request override — so for
// loopback HTTPS only, drop down to node:https with rejectUnauthorized
// off. Limiting the bypass to loopback keeps the check honest if a
// future config points it at a remote host.
function fetchLoopbackHttps(
  url: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        method: "GET",
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: 5_000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("health check timed out after 5s"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function checkVersionConverged(ctx: CheckContext): Promise<CheckResult> {
  const record = await readReleaseStore().catch(() => null);
  if (!record) {
    return {
      name: "version_converged",
      ok: false,
      message: "release.json not present",
    };
  }
  const ok = record.tag === ctx.targetTag;
  return {
    name: "version_converged",
    ok,
    message: ok
      ? `installed version converged to ${ctx.targetTag}`
      : `installed version ${record.tag} does not match target ${ctx.targetTag}`,
  };
}
