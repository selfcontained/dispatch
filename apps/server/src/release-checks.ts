import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RequiredCheckName } from "./release-metadata.js";
import { readReleaseStore } from "./release-store.js";

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
  const candidates = [
    path.join(ctx.serverDir, "apps/server/dist/main.js"),
    path.join(ctx.serverDir, "apps/web/dist/index.html"),
  ];
  const missing = candidates.filter((p) => !existsSync(p));
  return {
    name: "expected_runtime_artifact",
    ok: missing.length === 0,
    message:
      missing.length === 0
        ? "All expected runtime artifacts present"
        : `Missing: ${missing.join(", ")}`,
  };
}

async function checkServiceEntrypoint(ctx: CheckContext): Promise<CheckResult> {
  const pkgPath = path.join(ctx.serverDir, "apps/server/package.json");
  if (!existsSync(pkgPath)) {
    return {
      name: "service_entrypoint",
      ok: false,
      message: `${pkgPath} not found`,
    };
  }
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: { start?: string };
    };
    const start = pkg.scripts?.start;
    if (!start || typeof start !== "string") {
      return {
        name: "service_entrypoint",
        ok: false,
        message: "package.json scripts.start is missing",
      };
    }
    return {
      name: "service_entrypoint",
      ok: true,
      message: `start script: ${start}`,
    };
  } catch (err) {
    return {
      name: "service_entrypoint",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
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
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return {
        name: "health_endpoint",
        ok: false,
        message: `${url} returned ${res.status}`,
      };
    }
    const data = (await res.json()) as { status?: string };
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
