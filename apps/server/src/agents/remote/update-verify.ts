import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  runnerUpdateFilePath,
  type RunnerUpdateFile,
} from "./update-artifact-path.js";
import {
  RUNNER_ARCHES,
  RUNNER_UPDATE_DIGEST,
  RUNNER_UPDATE_MANIFEST_LIMIT,
  RUNNER_UPDATE_VERSION,
  verifyRunnerUpdateEnvelope,
  type RunnerArch,
  type RunnerUpdateKeys,
  type RunnerUpdateManifest,
} from "./update-manifest.js";

/*
 * The root updater's staging step. Its only input is the systemd instance
 * `<version>_linux_<arch>_<sha256>`. The controller origin, its CA and every
 * path come from root-owned files written at install and enrolment. Nothing
 * here renames, stops or starts the installed runner.
 */

export const RUNNER_UPDATE_UNIT_PREFIX = "dispatch-runner-update@";
/** Far above the ~130 MB executable; bounds a decompression bomb. */
export const RUNNER_UPDATE_EXECUTABLE_LIMIT = 512 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 30 * 60_000;

export type RunnerUpdateRequest = RunnerUpdateManifest;

export type RunnerUpdateOutcome =
  | "staged"
  | "already_staged"
  | "already_installed";

/** Stable reason codes; the protocol's status frame can carry them as is. */
export type RunnerUpdateRefusal =
  | "invalid_request"
  | "platform_mismatch"
  | "untrusted_state"
  | "downgrade"
  | "version_conflict"
  | "download_failed"
  | "verify_failed";

export class RunnerUpdateRefused extends Error {
  constructor(
    readonly reason: RunnerUpdateRefusal,
    message: string
  ) {
    super(message);
  }
}

function refuse(reason: RunnerUpdateRefusal, message: string): never {
  throw new RunnerUpdateRefused(reason, message);
}

export function runnerUpdateInstance(request: RunnerUpdateRequest) {
  return `${request.version}_${request.os}_${request.arch}_${request.sha256}`;
}

/** The whole caller-supplied input. Anything else is refused before use. */
export function parseRunnerUpdateInstance(
  instance: unknown
): RunnerUpdateRequest {
  const match =
    typeof instance === "string"
      ? /^([^_]{1,64})_linux_(x64|arm64)_([a-f0-9]{64})$/.exec(instance)
      : null;
  if (
    !match ||
    !RUNNER_UPDATE_VERSION.test(match[1]!) ||
    !RUNNER_UPDATE_DIGEST.test(match[3]!)
  )
    refuse("invalid_request", "Runner update request is malformed");
  return {
    version: match[1]!,
    os: "linux",
    arch: match[2] as RunnerArch,
    sha256: match[3]!,
  };
}

function compareIdentifiers(left: string, right: string) {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = left.replace(/^0+(?=.)/, "");
    const b = right.replace(/^0+(?=.)/, "");
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** SemVer precedence. A release outranks its prereleases. */
export function compareRunnerVersions(left: string, right: string) {
  if (!RUNNER_UPDATE_VERSION.test(left) || !RUNNER_UPDATE_VERSION.test(right))
    throw new Error("Invalid runner version");
  const split = (value: string) => {
    const dash = value.indexOf("-");
    return dash < 0
      ? { core: value.split("."), pre: [] as string[] }
      : {
          core: value.slice(0, dash).split("."),
          pre: value.slice(dash + 1).split("."),
        };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index++) {
    const order = compareIdentifiers(a.core[index]!, b.core[index]!);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const order = compareIdentifiers(a.pre[index]!, b.pre[index]!);
    if (order) return order;
  }
  return 0;
}

export type RunnerUpdateLayout = {
  /** Enrolment settings: the controller endpoint and CA path. */
  config: string;
  /** The installed executable this updater is running from. */
  installed: string;
  /** Private directory on the installed executable's filesystem. */
  staging: string;
  /** Private updater state, including the confirmed-version floor. */
  state: string;
};

export const RUNNER_UPDATE_LAYOUT: RunnerUpdateLayout = {
  config: "/etc/dispatch-runner/runner.json",
  installed: "/opt/dispatch-runner/dispatch",
  staging: "/opt/dispatch-runner/update",
  state: "/var/lib/dispatch-runner/update",
};

export type StageRunnerUpdateOptions = {
  layout: RunnerUpdateLayout;
  keys: RunnerUpdateKeys;
  host: { os: string; arch: string };
  installedVersion: string;
  /** Owner required of every trusted file and directory (root in service). */
  trustedUid: number;
};

export type StageRunnerUpdateResult = {
  outcome: RunnerUpdateOutcome;
  target: RunnerUpdateRequest;
  /** The verified candidate, for `staged` and `already_staged`. */
  candidate?: string;
};

export function candidatePath(layout: RunnerUpdateLayout, sha256: string) {
  return path.join(layout.staging, `dispatch-${sha256}`);
}

async function trusted(
  file: string,
  kind: "file" | "directory",
  uid: number,
  privateMode: boolean
) {
  let stat: Stats;
  try {
    stat = await lstat(file);
  } catch {
    refuse("untrusted_state", `Updater state ${file} is missing`);
  }
  const typeOk = kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!typeOk || stat.uid !== uid || stat.mode & (privateMode ? 0o077 : 0o022))
    refuse(
      "untrusted_state",
      `Updater state ${file} is not a ${privateMode ? "private " : ""}root-owned ${kind}`
    );
  return stat;
}

async function readTrustedText(file: string, uid: number, limit: number) {
  await trusted(file, "file", uid, false);
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.size > limit)
      refuse("untrusted_state", `Updater state ${file} is invalid`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

type Controller = { origin: URL; ca: string };

/** The enrolled endpoint and CA, never anything the request names. */
async function enrolledController(
  layout: RunnerUpdateLayout,
  uid: number
): Promise<Controller> {
  let settings: { endpoint?: unknown; ca?: unknown };
  try {
    settings = JSON.parse(await readTrustedText(layout.config, uid, 1 << 20));
  } catch (error) {
    if (error instanceof RunnerUpdateRefused) throw error;
    refuse("untrusted_state", "Runner settings are unreadable");
  }
  let origin: URL;
  try {
    origin = new URL(String(settings.endpoint));
  } catch {
    refuse("untrusted_state", "The runner is not enrolled");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== "/" && origin.pathname !== "")
  )
    refuse("untrusted_state", "The enrolled endpoint is not an HTTPS origin");
  if (typeof settings.ca !== "string" || !path.isAbsolute(settings.ca))
    refuse("untrusted_state", "The enrolled CA path is invalid");
  await trusted(path.dirname(settings.ca), "directory", uid, false);
  const ca = await readTrustedText(settings.ca, uid, 64 * 1024);
  return { origin, ca };
}

export async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

type Floor = { version: string; sha256: string };

/** Temporaries name their writer so a later run removes only dead ones. */
function temporaryPath(directory: string) {
  return path.join(
    directory,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeAtomic(directory: string, name: string, data: string) {
  const temporary = temporaryPath(directory);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path.join(directory, name));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The lowest version this runner may run. Kept by the updater alone and
 * seeded from the installed build; the controller cannot lower it.
 */
async function confirmedFloor(
  layout: RunnerUpdateLayout,
  installed: Floor,
  uid: number
): Promise<Floor> {
  const file = path.join(layout.state, "floor.json");
  let text: string;
  try {
    text = await readTrustedText(file, uid, 4096);
  } catch (error) {
    if (
      error instanceof RunnerUpdateRefused &&
      (await lstat(file).catch(() => undefined)) === undefined
    ) {
      await writeAtomic(layout.state, "floor.json", JSON.stringify(installed));
      return installed;
    }
    throw error;
  }
  try {
    const floor = JSON.parse(text) as Partial<Floor>;
    if (
      typeof floor.version === "string" &&
      RUNNER_UPDATE_VERSION.test(floor.version) &&
      typeof floor.sha256 === "string" &&
      RUNNER_UPDATE_DIGEST.test(floor.sha256)
    )
      return { version: floor.version, sha256: floor.sha256 };
  } catch {
    // Fall through: a damaged floor never permits a downgrade.
  }
  refuse("untrusted_state", "The confirmed-version floor is unreadable");
}

type Fetched = { body: Readable };

function fetchControllerFile(
  controller: Controller,
  request: RunnerUpdateRequest,
  file: RunnerUpdateFile
): Promise<Fetched> {
  const url = new URL(runnerUpdateFilePath(request, file), controller.origin);
  if (url.origin !== controller.origin.origin)
    refuse("download_failed", "Runner update URL left the enrolled origin");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const outgoing = https.get(
      {
        host,
        port: url.port || 443,
        path: url.pathname,
        ca: controller.ca,
        ...(isIP(host) ? {} : { servername: host }),
        agent: false,
        headers: { accept: "*/*", "accept-encoding": "identity" },
      },
      (response) => {
        // A redirect is never followed: the file must come from this origin.
        if (response.statusCode !== 200) {
          response.resume();
          outgoing.destroy();
          reject(
            new RunnerUpdateRefused(
              "download_failed",
              `Controller answered ${response.statusCode} for ${file}`
            )
          );
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding !== undefined && encoding !== "identity") {
          response.destroy();
          reject(
            new RunnerUpdateRefused(
              "download_failed",
              "Controller used an unexpected content encoding"
            )
          );
          return;
        }
        // The request's socket timeout below bounds idle gaps in the body.
        const total = setTimeout(
          () => response.destroy(new Error("Runner update download timed out")),
          TOTAL_TIMEOUT_MS
        );
        response.once("close", () => clearTimeout(total));
        resolve({ body: response });
      }
    );
    outgoing.setTimeout(IDLE_TIMEOUT_MS, () =>
      outgoing.destroy(new Error("Controller stopped responding"))
    );
    outgoing.once("error", (error) =>
      reject(
        error instanceof RunnerUpdateRefused
          ? error
          : new RunnerUpdateRefused(
              "download_failed",
              `Could not reach the controller: ${error.message}`
            )
      )
    );
  });
}

async function readBounded(body: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      body.destroy();
      refuse("verify_failed", "Runner update manifest is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Write decompressed bytes to a private file and hash them on the way. */
async function downloadExecutable(
  body: Readable,
  handle: FileHandle
): Promise<string> {
  const hash = createHash("sha256");
  const gunzip = createGunzip();
  body.once("error", (error) => gunzip.destroy(error));
  body.pipe(gunzip);
  let size = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > RUNNER_UPDATE_EXECUTABLE_LIMIT)
        refuse("verify_failed", "Runner update executable is too large");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset);
        offset += bytesWritten;
      }
    }
  } catch (error) {
    body.destroy();
    gunzip.destroy();
    if (error instanceof RunnerUpdateRefused) throw error;
    refuse(
      "download_failed",
      `Runner update download failed: ${(error as Error).message}`
    );
  }
  return hash.digest("hex");
}

/**
 * Remove temporaries left by a killed run and candidates for any other
 * build. A live writer's temporary is never touched.
 */
async function pruneStaging(layout: RunnerUpdateLayout, keep?: string) {
  for (const directory of [layout.staging, layout.state]) {
    for (const name of await readdir(directory)) {
      const writer = /^\.tmp-([1-9][0-9]{0,9})-[a-f0-9]{16}$/.exec(name);
      if (writer ? alive(Number(writer[1])) : directory !== layout.staging)
        continue;
      if (
        writer ||
        (/^dispatch-[a-f0-9]{64}(?:\.manifest\.json)?$/.test(name) &&
          name !== keep &&
          name !== `${keep}.manifest.json`)
      )
        await rm(path.join(directory, name), { force: true });
    }
  }
}

async function verifiedCandidate(
  layout: RunnerUpdateLayout,
  request: RunnerUpdateRequest,
  keys: RunnerUpdateKeys,
  uid: number
) {
  const file = candidatePath(layout, request.sha256);
  try {
    await trusted(file, "file", uid, true);
    const envelope = JSON.parse(
      await readTrustedText(
        `${file}.manifest.json`,
        uid,
        RUNNER_UPDATE_MANIFEST_LIMIT
      )
    );
    const manifest = verifyRunnerUpdateEnvelope(envelope, keys);
    if (
      manifest.version === request.version &&
      manifest.arch === request.arch &&
      manifest.sha256 === request.sha256 &&
      (await sha256File(file)) === request.sha256
    )
      return file;
  } catch {
    // Missing or damaged: staging starts over.
  }
  return undefined;
}

/**
 * Verify order: request shape, host platform, trusted local state, installed
 * identity and floor, signed manifest equals the request, then the
 * downloaded bytes equal the signed digest. Only then does a candidate
 * appear, by rename, in the private staging directory.
 */
export async function stageRunnerUpdate(
  instance: unknown,
  options: StageRunnerUpdateOptions
): Promise<StageRunnerUpdateResult> {
  const { layout, keys, host, trustedUid: uid } = options;
  const request = parseRunnerUpdateInstance(instance);
  if (host.os !== request.os || host.arch !== request.arch)
    refuse(
      "platform_mismatch",
      `This runner is ${host.os}/${host.arch}, not ${request.os}/${request.arch}`
    );
  if (!RUNNER_UPDATE_VERSION.test(options.installedVersion))
    refuse("untrusted_state", "The installed runner version is unknown");

  await trusted(layout.staging, "directory", uid, true);
  await trusted(layout.state, "directory", uid, true);
  await trusted(layout.installed, "file", uid, false);
  const controller = await enrolledController(layout, uid);

  const installed = {
    version: options.installedVersion,
    sha256: await sha256File(layout.installed),
  };
  const floor = await confirmedFloor(layout, installed, uid);
  if (request.sha256 === installed.sha256) {
    await pruneStaging(layout);
    return { outcome: "already_installed", target: request };
  }
  for (const known of [installed, floor]) {
    const order = compareRunnerVersions(request.version, known.version);
    if (order < 0)
      refuse(
        "downgrade",
        `Refusing ${request.version}: below ${known.version}`
      );
    if (order === 0 && known.sha256 !== request.sha256)
      refuse(
        "version_conflict",
        `Refusing a different build of version ${request.version}`
      );
  }

  const existing = await verifiedCandidate(layout, request, keys, uid);
  if (existing) {
    await pruneStaging(layout, path.basename(existing));
    return { outcome: "already_staged", target: request, candidate: existing };
  }

  const manifestResponse = await fetchControllerFile(
    controller,
    request,
    "manifest.json"
  );
  let envelopeBytes: Buffer;
  try {
    envelopeBytes = await readBounded(
      manifestResponse.body,
      RUNNER_UPDATE_MANIFEST_LIMIT
    );
  } catch (error) {
    if (error instanceof RunnerUpdateRefused) throw error;
    refuse("download_failed", "Runner update manifest download failed");
  }
  let manifest: RunnerUpdateManifest;
  try {
    manifest = verifyRunnerUpdateEnvelope(
      JSON.parse(envelopeBytes.toString("utf8")),
      keys
    );
  } catch (error) {
    refuse(
      "verify_failed",
      `Runner update manifest rejected: ${(error as Error).message}`
    );
  }
  if (
    manifest.version !== request.version ||
    manifest.os !== request.os ||
    manifest.arch !== request.arch ||
    manifest.sha256 !== request.sha256
  )
    refuse("verify_failed", "Signed manifest names a different build");

  const temporary = temporaryPath(layout.staging);
  const candidate = candidatePath(layout, request.sha256);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    const executable = await fetchControllerFile(
      controller,
      request,
      "dispatch-runner.gz"
    );
    const digest = await downloadExecutable(executable.body, handle);
    if (digest !== manifest.sha256)
      refuse(
        "verify_failed",
        "Downloaded executable does not match the signed digest"
      );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o700);
    await writeAtomic(
      layout.staging,
      `${path.basename(candidate)}.manifest.json`,
      envelopeBytes.toString("utf8")
    );
    await rename(temporary, candidate);
    await syncDirectory(layout.staging);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await pruneStaging(layout, path.basename(candidate));
  return { outcome: "staged", target: request, candidate };
}
