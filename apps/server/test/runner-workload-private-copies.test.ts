import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  BINARY_BYTES,
  JPEG_BYTES,
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
} from "./helpers/file-bytes.js";
import * as controllerErrors from "../src/shared/lib/error-message.js";
import * as runnerErrors from "../../../packages/runner/src/workload/shared/lib/error-message.js";
import * as controllerVersions from "../src/shared/lib/compare-semver.js";
import * as runnerVersions from "../../../packages/runner/src/workload/shared/lib/compare-semver.js";
import * as controllerPaths from "../src/shared/lib/resolve-tilde.js";
import * as runnerPaths from "../../../packages/runner/src/workload/shared/lib/resolve-tilde.js";
import * as controllerCommands from "../src/shared/lib/run-command.js";
import * as runnerCommands from "../../../packages/runner/src/workload/shared/lib/run-command.js";
import * as controllerTools from "../src/shared/lib/tool-environment.js";
import * as runnerTools from "../../../packages/runner/src/workload/shared/lib/tool-environment.js";
import * as controllerEnv from "../src/shared/process/child-environment.js";
import * as runnerEnv from "../../../packages/runner/src/workload/shared/process/child-environment.js";
import * as controllerOwned from "../src/shared/process/owned-processes.js";
import * as runnerOwned from "../../../packages/runner/src/workload/shared/process/owned-processes.js";
import * as controllerIcons from "../src/shared/icon-scan.js";
import * as runnerIcons from "../../../packages/runner/src/workload/shared/icon-scan.js";
import * as controllerDimensions from "../src/files/image-dimensions.js";
import * as runnerDimensions from "../../../packages/runner/src/workload/files/image-dimensions.js";
import * as controllerTypes from "../src/files/file-type.js";
import * as runnerTypes from "../../../packages/runner/src/workload/files/file-type.js";
import * as controllerExtensions from "../src/shared/file-types.js";
import * as runnerExtensions from "../../../packages/runner/src/workload/shared/file-types.js";
import * as controllerMedia from "../../../packages/shared/src/chat-types.js";
import * as runnerMedia from "../../../packages/runner/src/workload/shared/file-media.js";
import * as controllerFiles from "../src/files/open-workspace-file.js";
import * as runnerFiles from "../../../packages/runner/src/workload/files/open-workspace-file.js";

let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "workload-copies-")));
  await mkdir(path.join(root, "dir"));
  await writeFile(path.join(root, "dir", "sample"), "example");
  await symlink("dir", path.join(root, "link"));
  await symlink("dir/sample", path.join(root, "file-link"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("formats the same errors, version comparisons and configured paths", () => {
  for (const value of [new Error("sample"), "", null, 0, { reason: "failure" }])
    expect(runnerErrors.errorMessage(value)).toBe(
      controllerErrors.errorMessage(value)
    );
  for (const a of ["0", "1.2", "1.02.3", "v2.0.0", "1.2.3-beta.1", "unknown"])
    for (const b of ["1.2.3", "2", a])
      expect(runnerVersions.compareSemver(a, b)).toBe(
        controllerVersions.compareSemver(a, b)
      );
  for (const value of ["", "~", "~/folder", "~other", "./relative", root]) {
    expect(runnerPaths.resolveTilde(value)).toBe(
      controllerPaths.resolveTilde(value)
    );
    expect(runnerPaths.resolveConfiguredPath(value)).toBe(
      controllerPaths.resolveConfiguredPath(value)
    );
  }
});

it("filters inherited configuration and orders tool search directories identically", async () => {
  const fixture = {
    HOME: root,
    PATH: [root, "/usr/local/bin", root].join(path.delimiter),
    DISPATCH_AGENT_ID: "old",
    DISPATCH_OWNED_0123456789abcdef0123456789abcdef: "1",
    DATABASE_URL: "sample",
    PGPORT: "sample",
    TLS_TEST: "sample",
    KEEP: "yes",
    MISSING: undefined,
  };
  for (const versions of [[], ["v9", "v20"]]) {
    for (const v of versions)
      await mkdir(path.join(root, ".nvm/versions/node", v), {
        recursive: true,
      });
    expect(runnerEnv.childProcessEnv(fixture)).toEqual(
      controllerEnv.childProcessEnv(fixture)
    );
    expect(runnerTools.defaultSearchDirs(root)).toEqual(
      controllerTools.defaultSearchDirs(root)
    );
    expect(runnerTools.withToolSearchPath(fixture)).toEqual(
      controllerTools.withToolSearchPath(fixture)
    );
    expect(runnerTools.repoCommandEnvironment("owner", fixture)).toEqual(
      controllerTools.repoCommandEnvironment("owner", fixture)
    );
  }
});

async function outcome<T>(action: () => Promise<T> | T) {
  try {
    return { value: await action() };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return { code: e.code, message: e.message };
  }
}
it("returns matching process output, exit failures and timeout errors", async () => {
  const run = async (fn: typeof controllerCommands.runCommand) => {
    const script =
      "process.stdout.write(' '+process.env.SAMPLE+' ');process.stderr.write('diagnostic');process.exit(3)";
    const opts = { cwd: root, env: { SAMPLE: "sample" } };
    return [
      await outcome(() =>
        fn(process.execPath, ["-e", script], {
          ...opts,
          allowedExitCodes: [3],
          trimOutput: false,
        })
      ),
      await outcome(() => fn(process.execPath, ["-e", script], opts)),
      await outcome(() =>
        fn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          timeoutMs: 40,
        })
      ),
    ];
  };
  expect(await run(runnerCommands.runCommand)).toEqual(
    await run(controllerCommands.runCommand)
  );
});

it("recognizes and cleans up only the fixture's uniquely marked process", async () => {
  async function exercise(impl: typeof controllerOwned) {
    const { env, marker } = impl.ownedEnvironment({ KEEP: "yes" });
    expect(marker).toMatch(/^DISPATCH_OWNED_[a-f0-9]{32}=1$/);
    const [key] = marker.split("=");
    expect(env).toEqual({ KEEP: "yes", [key]: "1" });
    const invalid = await outcome(() => impl.killOwnedProcesses("invalid"));
    if (process.platform === "win32")
      return [invalid, impl.ownedProcessPids(marker)];
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env,
      stdio: "ignore",
    });
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      const onlyChild = impl.ownedProcessPids(marker);
      expect(onlyChild).toEqual([child.pid]);
      impl.killOwnedProcesses(marker);
      return [invalid, await exited, impl.ownedProcessPids(marker)];
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  }
  expect(await exercise(runnerOwned)).toEqual(await exercise(controllerOwned));
});

it("uses the same icon lookup order, skips hidden directories and handles unreadable trees", async () => {
  for (const conventional of [true, false]) {
    async function scan(fn: typeof controllerIcons.detectIconFrom) {
      const calls: string[] = [];
      const found = await fn({
        async isFile(rel) {
          calls.push(rel);
          return conventional && rel === ".dispatch/logo.png";
        },
        async list(rel) {
          calls.push(rel);
          if (rel === "")
            return [
              { name: "assets", kind: "directory" },
              { name: ".hidden", kind: "directory" },
              { name: "logo.png", kind: "file" },
              { name: "missing", kind: "directory" },
            ];
          return rel === "assets"
            ? [{ name: "favicon.svg", kind: "file" }]
            : null;
        },
      });
      return { found, calls };
    }
    expect(await scan(runnerIcons.detectIconFrom)).toEqual(
      await scan(controllerIcons.detectIconFrom)
    );
  }
});
it("classifies the same filenames, MIME types, byte signatures and dimensions", () => {
  expect([...runnerExtensions.TEXT_EXTENSIONS]).toEqual([
    ...controllerExtensions.TEXT_EXTENSIONS,
  ]);
  for (const mime of [
    undefined,
    "",
    "text/plain",
    "image/svg+xml",
    "application/pdf",
    "video/mp4",
    "application/json",
    "application/octet-stream",
  ])
    expect(runnerMedia.fileMedia(mime)).toBe(controllerMedia.fileMedia(mime));
  for (const name of [
    "README",
    "file.TXT",
    "thing.svg",
    "file.png",
    "video.mp4",
    "unknown.zzz",
    ".env",
  ]) {
    expect(runnerExtensions.fileExtension(name)).toBe(
      controllerExtensions.fileExtension(name)
    );
    expect(runnerExtensions.isTextFile(name)).toBe(
      controllerExtensions.isTextFile(name)
    );
    expect(runnerTypes.claimedMimeType(name)).toBe(
      controllerTypes.claimedMimeType(name)
    );
    for (const bytes of [
      PNG_BYTES,
      JPEG_BYTES,
      MP4_BYTES,
      PDF_BYTES,
      BINARY_BYTES,
      Buffer.from("<svg/>"),
      Buffer.from("hello"),
      Buffer.from("47494638396103000200000000", "hex"),
      Buffer.alloc(0),
    ]) {
      expect(runnerTypes.detectFileType(bytes, name)).toEqual(
        controllerTypes.detectFileType(bytes, name)
      );
      for (const ignoreExifOrientation of [false, true])
        expect(
          runnerDimensions.imageDimensionsFromBuffer(bytes, {
            ignoreExifOrientation,
          })
        ).toEqual(
          controllerDimensions.imageDimensionsFromBuffer(bytes, {
            ignoreExifOrientation,
          })
        );
    }
  }
});

it("opens identical regular files and rejects the same symlinks and non-files", async () => {
  async function read(impl: typeof runnerFiles, segments: string[]) {
    const handle = await impl.openRegularFile(root, segments);
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }
  for (const segments of [
    ["dir", "sample"],
    ["missing"],
    ["dir"],
    ["link", "sample"],
    ["file-link"],
  ])
    expect(await outcome(() => read(runnerFiles, segments))).toEqual(
      await outcome(() => read(controllerFiles, segments))
    );
});
it.runIf(process.platform === "linux")(
  "pins the same Linux directory components",
  async () => {
    async function inspect(impl: typeof runnerFiles, target: string) {
      const handle = await impl.openLinuxDirectory(path.join(root, target));
      try {
        const stat = await handle.stat();
        return [stat.dev, stat.ino, stat.isDirectory()];
      } finally {
        await handle.close();
      }
    }
    for (const target of ["dir", "link", "missing", "dir/sample"]) {
      const runner = await outcome(() => inspect(runnerFiles, target));
      const controller = await outcome(() => inspect(controllerFiles, target));
      // procfs paths in native error messages may use different temporary fd numbers.
      expect(
        JSON.stringify(runner).replace(/\/proc\/self\/fd\/\d+/g, "<fd>")
      ).toEqual(
        JSON.stringify(controller).replace(/\/proc\/self\/fd\/\d+/g, "<fd>")
      );
    }
  }
);
