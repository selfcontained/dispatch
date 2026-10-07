import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { useInjectApp } from "./helpers/inject-app.js";

const { runCommandMock, ensureCachedTarballMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
  ensureCachedTarballMock: vi.fn(),
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

vi.mock("../src/release-tarball-cache.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/release-tarball-cache.js")>();
  return { ...actual, ensureCachedTarball: ensureCachedTarballMock };
});

// Exercise protected-update admission on every host, including macOS CI.
// The route tests stop at mocked artifact download; no recovery helper is run.
vi.mock("../src/server/release-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/server/release-runtime.js")>();
  return {
    ...actual,
    createReleaseRuntime: (
      deps: Parameters<typeof actual.createReleaseRuntime>[0]
    ) =>
      actual.createReleaseRuntime({ ...deps, applyProtectedUpdate: vi.fn() }),
  };
});

let sessionCookie: string;
const tempRoot = mkdtempSync(
  path.join(os.tmpdir(), "dispatch-release-routes-")
);
const releaseStorePath = path.join(tempRoot, "release.json");
const rootPackageVersion = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../../package.json"),
      "utf8"
    )
  ) as { version: string }
).version;
const packagedCurrentTag = `v${rootPackageVersion}`;

beforeAll(async () => {
  await mkdir(path.join(os.homedir(), ".dispatch", "server"), {
    recursive: true,
  });
});

const ctx = useInjectApp({
  env: { DISPATCH_RELEASE_STORE_PATH: releaseStorePath },
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  runCommandMock.mockReset();
  ensureCachedTarballMock.mockRejectedValue(
    new Error("artifact download disabled in route test")
  );
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM sessions");
  await writeReleaseStore({
    tag: "v0.18.0",
    deployedAt: "2026-04-01T00:00:00Z",
  });

  sessionCookie = await ctx.sessionCookie();
});

describe("release metadata route handling", () => {
  it("blocks tarball updates for an app-owned server", async () => {
    vi.stubEnv("DISPATCH_UPDATE_OWNER", "macos-app");
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release/update",
        headers: { cookie: sessionCookie },
        payload: { tag: "v99.0.0" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "MAC_APP_MANAGED" });
      expect(ensureCachedTarballMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("identifies the app instance in its health response without exposing credentials", async () => {
    vi.stubEnv("DISPATCH_UPDATE_OWNER", "macos-app");
    vi.stubEnv("DISPATCH_MAC_INSTANCE_ID", "preview-test-instance");
    try {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/health",
      });
      expect(response.json()).toMatchObject({
        status: "ok",
        updateOwner: "macos-app",
        macInstanceId: "preview-test-instance",
      });
      expect(response.body).not.toContain("DATABASE_URL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("admin unreleased-commit enrichment", () => {
    const authoringDir = "/srv/authoring-checkout";

    beforeEach(async () => {
      vi.stubEnv("DISPATCH_RELEASE_AUTHORING", "1");
      vi.stubEnv("DISPATCH_RELEASE_AUTHORING_REPO_DIR", authoringDir);
      // The fetch coalescer caches per-checkout results for its TTL;
      // clear it so each test observes its own fetch.
      const { authoringRemoteRefresher } =
        await import("../src/routes/release.js");
      authoringRemoteRefresher.reset();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("fetches origin/main in the authoring checkout before counting", async () => {
      mockReleaseCommands({
        releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });
      const base = runCommandMock.getMockImplementation()!;
      runCommandMock.mockImplementation(async (cmd, args, opts) => {
        if (
          cmd === "git" &&
          args.includes("rev-parse") &&
          args.includes("--verify")
        ) {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (cmd === "git" && args.includes("rev-list")) {
          return { exitCode: 0, stdout: "3", stderr: "" };
        }
        if (cmd === "git" && args.includes("log")) {
          return {
            exitCode: 0,
            stdout: [
              "1111111aaaaaaa\tfix: one",
              "2222222bbbbbbb\tfeat: two",
              "3333333ccccccc\tchore: three",
            ].join("\n"),
            stderr: "",
          };
        }
        return base(cmd, args, opts);
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/release/info",
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        isAdmin: true,
        unreleasedCount: 3,
        refMissing: false,
        unreleasedFetchError: null,
        commits: [
          { sha: "1111111", subject: "fix: one" },
          { sha: "2222222", subject: "feat: two" },
          { sha: "3333333", subject: "chore: three" },
        ],
      });

      const gitCalls = runCommandMock.mock.calls.filter(
        (call): call is [string, string[]] => call[0] === "git"
      );
      const fetchCall = gitCalls.find(([, args]) => args.includes("fetch"));
      expect(fetchCall?.[1]).toEqual([
        "-C",
        authoringDir,
        "fetch",
        "--quiet",
        "--tags",
        "origin",
        "main",
      ]);
      const enrichmentCalls = gitCalls.filter(([, args]) =>
        ["rev-parse", "rev-list", "log"].some((sub) => args.includes(sub))
      );
      expect(enrichmentCalls.length).toBeGreaterThan(0);
      for (const [, args] of enrichmentCalls) {
        expect(args.slice(0, 2)).toEqual(["-C", authoringDir]);
      }
    });

    it("reports a fetch failure instead of zero unreleased commits", async () => {
      mockReleaseCommands({
        releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });
      const base = runCommandMock.getMockImplementation()!;
      runCommandMock.mockImplementation(async (cmd, args, opts) => {
        if (cmd === "git" && args.includes("fetch")) {
          throw new Error(
            "Command failed (git fetch), exitCode=128, stderr=could not resolve host"
          );
        }
        return base(cmd, args, opts);
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/release/info",
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { unreleasedFetchError: string };
      expect(body).toMatchObject({
        isAdmin: true,
        unreleasedCount: 0,
        refMissing: false,
        unreleasedFetchError: expect.stringContaining(
          "Unable to refresh origin/main"
        ),
      });
      // Sanitized: raw git stderr must not reach the client.
      expect(body.unreleasedFetchError).not.toContain("could not resolve host");
      const comparisonCalls = runCommandMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "git" &&
          ["rev-parse", "rev-list", "log"].some((sub) =>
            (args as string[]).includes(sub)
          )
      );
      expect(comparisonCalls).toHaveLength(0);
    });
  });

  it("falls back to the packaged app version when no release tag is recorded", async () => {
    await rm(releaseStorePath, { force: true });
    mockReleaseCommands({
      releaseList: [{ tagName: "v0.18.36", isPrerelease: false }],
      releaseViews: {
        "v0.18.36": validReleaseView({
          body: "no fenced metadata",
          tag: "v0.18.36",
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/info",
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currentTag: packagedCurrentTag,
      latestTag: "v0.18.36",
      updateAvailable: compareSemverForTest("v0.18.36", packagedCurrentTag) > 0,
    });
  });

  it("promotes through the workflow that also moves the macOS appcast", async () => {
    vi.stubEnv("DISPATCH_RELEASE_AUTHORING", "1");
    mockReleaseCommands({});

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/promote",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v1.0.0" },
    });
    vi.unstubAllEnvs();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      tag: "v1.0.0",
      workflowUrl:
        "https://github.com/selfcontained/dispatch/actions/workflows/promote-release.yml",
    });
    const run = runCommandMock.mock.calls.find(
      ([cmd, args]) => cmd === "gh" && args[0] === "workflow"
    );
    expect(run?.[1]).toEqual([
      "workflow",
      "run",
      "promote-release.yml",
      "--repo",
      "selfcontained/dispatch",
      "--ref",
      "main",
      "--field",
      "tag=v1.0.0",
    ]);
    expect(
      runCommandMock.mock.calls.some(
        ([cmd, args]) => cmd === "gh" && args[0] === "release"
      )
    ).toBe(false);
  });

  it("stores the preview channel and rejects unknown channels", async () => {
    const set = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/channel",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { channel: "preview" },
    });
    expect(set.statusCode).toBe(200);
    const get = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/channel",
      headers: { cookie: sessionCookie },
    });
    expect(get.json()).toEqual({ channel: "preview" });

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/channel",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { channel: "latest" },
    });
    expect(bad.statusCode).toBe(400);
  });

  describe("release-creation / update independence", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("allows /release/update while a release-creation job is in flight", async () => {
      vi.stubEnv("DISPATCH_RELEASE_AUTHORING", "1");
      mockReleaseCommands({
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });

      const createResp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { versionType: "patch" },
      });
      expect(createResp.statusCode).toBe(202);

      // Before the fix, a non-terminal "create" job made /release/update
      // 409 with "A release or update is already in progress." — release
      // creation and update application now use independent active-job
      // slots, so an in-flight release must not block an update apply.
      const updateResp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release/update",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { tag: "v0.19.0" },
      });
      expect(updateResp.statusCode).toBe(202);
      expect(updateResp.json()).toMatchObject({ ok: true });
    });

    it("blocks /release while an update job is in flight — the server is about to restart", async () => {
      // This is a deliberately one-way gate (round-2 review #1290): an
      // update job ends by restarting the server, so a release build
      // started during that window would get killed mid-run with no
      // clean way to surface that. Unlike the reverse direction, this
      // asymmetry is intentional.
      mockReleaseCommands({
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });
      // Keep the update job stuck mid-deploy (never resolves) so it's
      // still reliably non-terminal when /release is attempted — a real
      // update job stays non-terminal for the same reason (in-flight
      // network I/O) right up until the server restarts out from
      // under it.
      ensureCachedTarballMock.mockImplementation(() => new Promise(() => {}));

      const updateResp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release/update",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { tag: "v0.19.0" },
      });
      expect(updateResp.statusCode).toBe(202);

      vi.stubEnv("DISPATCH_RELEASE_AUTHORING", "1");
      const createResp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { versionType: "patch" },
      });
      expect(createResp.statusCode).toBe(409);
      expect(createResp.json()).toMatchObject({
        error: "An update is in progress; the server is about to restart.",
      });

      const secondUpdate = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release/update",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        payload: { tag: "v0.19.0" },
      });
      expect(secondUpdate.statusCode).toBe(409);
      expect(secondUpdate.json()).toMatchObject({
        error: "An update is already in progress.",
      });
    });
  });
});

async function writeReleaseStore(record: {
  tag: string;
  deployedAt: string;
}): Promise<void> {
  await writeFile(
    releaseStorePath,
    JSON.stringify(record, null, 2) + "\n",
    "utf8"
  );
}

function validReleaseView({
  body,
  tag = "v0.19.0",
}: {
  body: string | null;
  tag?: string;
}): string {
  return JSON.stringify({
    tagName: tag,
    publishedAt: "2026-04-26T00:00:00Z",
    assets: [
      { name: "dispatch-server.tar.gz", digest: `sha256:${"a".repeat(64)}` },
    ],
    url: `https://github.com/selfcontained/dispatch/releases/tag/${tag}`,
    body,
  });
}

function mockReleaseCommands({
  releaseList = [],
  releaseViews = {},
  viewerPermission = "ADMIN",
}: {
  releaseList?: Array<{ tagName: string; isPrerelease: boolean }>;
  releaseViews?: Record<string, string>;
  viewerPermission?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/releases?per_page=")) {
        return new Response(
          JSON.stringify(
            releaseList.map((release) => ({
              tag_name: release.tagName,
              published_at: "2026-04-26T00:00:00Z",
              html_url: `https://github.com/selfcontained/dispatch/releases/tag/${release.tagName}`,
              prerelease: release.isPrerelease,
              assets: [{ name: "dispatch-server.tar.gz" }],
            }))
          )
        );
      }
      const match = url.match(/\/releases\/tags\/([^/?]+)/);
      if (match) {
        const tag = decodeURIComponent(match[1]!);
        const raw = releaseViews[tag];
        if (!raw) return new Response("not found", { status: 404 });
        const view = JSON.parse(raw) as {
          tagName: string;
          publishedAt: string;
          url: string;
          body?: string | null;
          assets?: Array<{ name: string; digest?: string }>;
        };
        return new Response(
          JSON.stringify({
            tag_name: view.tagName,
            published_at: view.publishedAt,
            html_url: view.url,
            body: view.body,
            assets: view.assets,
          })
        );
      }
      return new Response("unexpected URL", { status: 500 });
    })
  );
  runCommandMock.mockImplementation(
    async (
      cmd: string,
      args: string[],
      opts?: { allowedExitCodes?: number[] }
    ) => {
      if (cmd === "gh" && args[0] === "--version") {
        return { exitCode: 0, stdout: "gh 2.0.0\n", stderr: "" };
      }
      // The Linux pre-deploy check that a restart keeps agent hosts alive.
      if (cmd === "systemctl" && args.includes("KillMode")) {
        return { exitCode: 0, stdout: "KillMode=process\n", stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("fetch") &&
        args.includes("origin") &&
        args.includes("--tags")
      ) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("remote") &&
        args.includes("get-url") &&
        args.includes("origin")
      ) {
        return {
          exitCode: 0,
          stdout: "git@github.com:selfcontained/dispatch.git\n",
          stderr: "",
        };
      }
      if (
        cmd === "gh" &&
        args[0] === "repo" &&
        args[1] === "view" &&
        args.includes("--jq")
      ) {
        return { exitCode: 0, stdout: `${viewerPermission}\n`, stderr: "" };
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(releaseList),
          stderr: "",
        };
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        const tag = args[2];
        const stdout = releaseViews[tag];
        if (!stdout) {
          throw new Error(`no mocked release view for ${tag}`);
        }
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("rev-parse") &&
        args.includes("--verify")
      ) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad revision",
        };
      }
      if (
        cmd === "git" &&
        args.includes("tag") &&
        args.includes("--sort=-version:refname")
      ) {
        return { exitCode: 0, stdout: "v0.19.0\nv0.18.0\n", stderr: "" };
      }
      if (
        cmd === "gh" &&
        args[0] === "workflow" &&
        args[2] === "promote-release.yml"
      ) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (opts?.allowedExitCodes?.includes(128)) {
        return { exitCode: 128, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    }
  );
}

function compareSemverForTest(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
