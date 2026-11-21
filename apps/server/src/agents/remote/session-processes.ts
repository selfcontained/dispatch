import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { ownedEnvironment } from "../../shared/process/owned-processes.js";
import {
  isBuildIdentity,
  isHostInstanceId,
  type BuildIdentity,
} from "../build-identity.js";
import { isOpaqueId } from "./protocol.js";
import type { WorkloadCommand } from "./session-storage.js";

type Kernel = ReturnType<typeof linuxKernel>;

export function runnerStateLockError(code: number): Error {
  if (code === 11)
    return new Error(
      "Another runner daemon is already using this state directory. Stop the other runner or configure a different state directory."
    );
  return new Error(`Cannot lock runner session state (errno ${code}).`);
}

function linuxKernel() {
  if (!process.versions.bun)
    throw new Error(
      "Runner session supervision requires the Bun runtime. Use the compiled Dispatch Linux binary."
    );
  // These two supported Linux architectures share the pidfd_send_signal ABI.
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error("Runner session supervision requires arm64 or x64 Linux.");
  const { dlopen, read } = createRequire(import.meta.url)(
    "bun:ffi"
  ) as typeof import("bun:ffi");
  const { symbols } = dlopen("libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    syscall: { args: ["i32", "i32", "i32", "ptr", "i32"], returns: "i32" },
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
    getsockopt: {
      args: ["i32", "i32", "i32", "ptr", "ptr"],
      returns: "i32",
    },
    __errno_location: { args: [], returns: "ptr" },
  });
  const errno = () => read.i32(symbols.__errno_location()!);
  return {
    socketPeer(socket: string) {
      // AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC.
      const fd = symbols.socket(1, 0x80801, 0);
      if (fd < 0) return null;
      try {
        const address = Buffer.alloc(110);
        address.writeUInt16LE(1);
        address.write(socket, 2);
        if (symbols.connect(fd, address, 3 + Buffer.byteLength(socket)) !== 0)
          return null;
        const credential = Buffer.alloc(12);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(credential.length);
        // SOL_SOCKET / SO_PEERCRED returns the connecting peer's signed PID
        // and unsigned UID/GID from the kernel, not the socket pathname.
        if (symbols.getsockopt(fd, 1, 17, credential, length) !== 0)
          return null;
        return {
          pid: credential.readInt32LE(),
          uid: credential.readUInt32LE(4),
        };
      } finally {
        closeSync(fd);
      }
    },
    lock(fd: number) {
      if (symbols.flock(fd, 2 | 4) !== 0) throw runnerStateLockError(errno());
    },
    signal(fd: number, signal: number) {
      if (symbols.syscall(424, fd, signal, null, 0) === 0) return;
      const code = errno();
      if (code !== 3)
        // ESRCH
        throw new Error(
          `Cannot signal runner session process (errno ${code}).`
        );
    },
  };
}

function tryProc<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return null;
    throw error;
  }
}

export function parseProcessStat(text: string) {
  // The comm field can contain whitespace, parentheses and newlines.
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const session = Number(fields[3]);
  const start = fields[19];
  if (!Number.isSafeInteger(session) || !start || !/^\d+$/.test(start))
    throw new Error("Invalid Linux process stat.");
  return { session, start, dead: fields[0] === "Z" || fields[0] === "X" };
}

function withProcess<T>(
  pid: number,
  operation: (fd: number, proc: string) => T
) {
  // Linux accepts an open /proc/PID directory as a pidfd for signaling.
  // Reading stat through the same descriptor also pins the lookup to that
  // instance of the task, even when a later process gets the numeric PID.
  const fd = tryProc(() =>
    openSync(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY)
  );
  if (fd === null) return null;
  try {
    return operation(fd, `/proc/self/fd/${fd}`);
  } finally {
    closeSync(fd);
  }
}

function statProcess(proc: string) {
  return tryProc(() => parseProcessStat(readFileSync(`${proc}/stat`, "utf8")));
}

export type SessionIdentity = {
  scope: string;
  pid: number;
  start: string;
  marker: string;
};

export type CurrentSessionIdentity = {
  handoffFormat: 2;
  sessionId: string;
  hostBuild: BuildIdentity;
  hostInstanceId: string;
};

export type RecordedSessionIdentity = SessionIdentity &
  Partial<Omit<CurrentSessionIdentity, "handoffFormat">> & {
    handoffFormat?: number;
  };

export function classifySessionIdentity(
  identity: RecordedSessionIdentity
):
  | { kind: "legacy"; format: 1 }
  | { kind: "current"; record: CurrentSessionIdentity }
  | { kind: "unknown" } {
  if (
    !("handoffFormat" in identity) &&
    !("sessionId" in identity) &&
    !("hostBuild" in identity) &&
    !("hostInstanceId" in identity)
  )
    return { kind: "legacy", format: 1 };
  const { handoffFormat, sessionId, hostBuild, hostInstanceId } = identity;
  if (
    handoffFormat === 2 &&
    isOpaqueId(sessionId) &&
    isBuildIdentity(hostBuild) &&
    isHostInstanceId(hostInstanceId)
  )
    return {
      kind: "current",
      record: { handoffFormat, sessionId, hostBuild, hostInstanceId },
    };
  return { kind: "unknown" };
}

export function validMarker(marker: unknown): marker is string {
  return (
    typeof marker === "string" && /^DISPATCH_OWNED_[a-f0-9]{32}=1$/.test(marker)
  );
}

export function parseSessionIdentity(raw: string): RecordedSessionIdentity {
  const identity = JSON.parse(raw) as RecordedSessionIdentity | null;
  if (
    !identity ||
    typeof identity.scope !== "string" ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 1 ||
    typeof identity.start !== "string" ||
    !/^\d+$/.test(identity.start) ||
    !validMarker(identity.marker)
  )
    throw new Error("Invalid runner host identity.");
  return identity;
}

export function openHostSocket(socketPath: string, uid: number) {
  // Pin the socket inode without following a workload-created symlink.
  const linuxOpenPath = 0x200000;
  const fd = openSync(socketPath, linuxOpenPath | constants.O_NOFOLLOW);
  try {
    const socket = fstatSync(fd);
    if (!socket.isSocket() || socket.uid !== uid)
      throw new Error("Guest host socket is unavailable");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export type SessionProcesses = ReturnType<typeof createSessionProcesses>;

export function createSessionProcesses(
  uid: number,
  asWorkload: WorkloadCommand
) {
  const kernel = linuxKernel();
  const scope = [
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    readlinkSync("/proc/self/ns/pid"),
  ].join(":");

  const withHost = <T>(
    identity: SessionIdentity,
    use: (fd: number, proc: string) => T
  ) => {
    if (identity.scope !== scope || identity.pid === process.pid) return null;
    return withProcess(identity.pid, (fd, proc) => {
      const found = statProcess(proc);
      if (
        !found ||
        found.dead ||
        found.start !== identity.start ||
        found.session !== identity.pid
      )
        return null;
      return use(fd, proc);
    });
  };
  const alive = (identity: SessionIdentity) =>
    withHost(identity, () => true) === true;

  // The launched host and engine inherit this exact marker. Match only the
  // configured workload UID, and hold descriptors across enumeration and
  // verification so recycled PIDs cannot be signaled. Read the environment
  // as the workload: container root can lack CAP_SYS_PTRACE.
  async function cleanup(marker: string) {
    if (!validMarker(marker)) throw new Error("Invalid runner process marker.");
    for (let pass = 0; pass < 4; pass++) {
      const pids = readdirSync("/proc").filter(
        (pid) => /^[1-9]\d*$/.test(pid) && Number(pid) !== process.pid
      );
      let found = false;
      for (let offset = 0; offset < pids.length; offset += 128) {
        const candidates: { fd: number; file: string }[] = [];
        try {
          for (const pid of pids.slice(offset, offset + 128)) {
            const fd = tryProc(() =>
              openSync(
                `/proc/${pid}`,
                constants.O_RDONLY | constants.O_DIRECTORY
              )
            );
            if (fd === null) continue;
            if (fstatSync(fd).uid === uid)
              candidates.push({ fd, file: `/proc/${pid}/environ` });
            else closeSync(fd);
          }
          if (!candidates.length) continue;
          // grep may see a child disappear between enumeration and open. Keep
          // its successful matches and handle exit codes other than 0/1/2.
          const output = await asWorkload("/usr/bin/grep", [
            "-azlFx",
            "--",
            marker,
            ...candidates.map(({ file }) => file),
          ]).catch((error) => {
            if ([1, 2].includes(error.code)) return String(error.stdout ?? "");
            throw error;
          });
          const matches = new Set(output.split("\n"));
          for (const { fd, file } of candidates) {
            if (!matches.has(file)) continue;
            const current = statProcess(`/proc/self/fd/${fd}`);
            if (!current || current.dead || fstatSync(fd).uid !== uid) continue;
            found = true;
            kernel.signal(fd, 9);
          }
        } finally {
          for (const { fd } of candidates) closeSync(fd);
        }
      }
      if (!found) return;
      await delay(25);
    }
    throw new Error("Runner session processes did not exit after cleanup.");
  }

  return {
    acquire(stateLock: string) {
      const fd = openSync(
        stateLock,
        constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
        0o600
      );
      try {
        kernel.lock(fd);
        // Confirm pidfd signaling is supported before accepting requests.
        withProcess(process.pid, (self) => kernel.signal(self, 0));
        return () => closeSync(fd);
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    },
    alive,
    socketMatchesHost(socketPath: string, identity: SessionIdentity) {
      return (
        withHost(identity, (fd, proc) => {
          if (fstatSync(fd).uid !== uid) return false;
          const socketFd = openHostSocket(socketPath, uid);
          try {
            const peer = kernel.socketPeer(`/proc/self/fd/${socketFd}`);
            return (
              peer?.pid === identity.pid &&
              peer.uid === uid &&
              statProcess(proc)?.dead === false
            );
          } finally {
            closeSync(socketFd);
          }
        }) === true
      );
    },
    async spawn(
      command: string[],
      cwd: string,
      env: NodeJS.ProcessEnv,
      log: number,
      record: (identity: SessionIdentity) => Promise<void>,
      onExit: (identity: SessionIdentity) => void
    ) {
      const owned = ownedEnvironment(env);
      // With undelivered stdin on supervisor death, the shell exits before
      // dropping privilege or running the host. After release, exec preserves
      // the PID and start time recorded while the root launcher was blocked.
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'IFS= read -r gate && [ "$gate" = start ] && exec "$@" </dev/null',
          "dispatch-host-gate",
          ...command,
        ],
        { cwd, env: owned.env, detached: true, stdio: ["pipe", log, log] }
      );
      let identity: SessionIdentity | undefined;
      child.stdin!.on("error", () => {});
      child.on("exit", () => {
        if (identity) onExit(identity);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.on("error", reject);
        });
        const pid = child.pid!;
        const proc = withProcess(pid, (_fd, dir) => statProcess(dir));
        if (!proc || proc.dead || proc.session !== pid)
          throw new Error(
            "Runner could not identify the detached host launcher."
          );
        identity = { scope, pid, start: proc.start, marker: owned.marker };
        await record(identity);
        child.stdin!.end("start\n");
        child.unref();
      } catch (error) {
        child.stdin!.destroy();
        throw error;
      }
    },
    async stop(identity: SessionIdentity, force: boolean) {
      const wait = async (ms: number) => {
        const deadline = performance.now() + ms;
        while (alive(identity) && performance.now() < deadline) await delay(50);
      };
      if (!force) {
        withHost(identity, (fd) => kernel.signal(fd, 15));
        await wait(8_000);
      }
      if (alive(identity)) {
        withHost(identity, (leader, leaderProc) => {
          // Force-stop members of the detached session even if they removed
          // their environment marker. Recheck the original leader through its
          // descriptor after reading each candidate's session membership.
          for (const entry of readdirSync("/proc")) {
            if (!/^[1-9]\d*$/.test(entry)) continue;
            const pid = Number(entry);
            if (pid === identity.pid || pid === process.pid) continue;
            withProcess(pid, (fd, proc) => {
              const member = statProcess(proc);
              const host = statProcess(leaderProc);
              if (
                member &&
                !member.dead &&
                member.session === identity.pid &&
                host &&
                !host.dead
              )
                kernel.signal(fd, 9);
            });
          }
          kernel.signal(leader, 9);
        });
        await wait(2_000);
      }
      if (alive(identity)) throw new Error("Guest agent host did not stop.");
    },
    cleanup(identity: SessionIdentity) {
      return identity.scope === scope
        ? cleanup(identity.marker)
        : Promise.resolve();
    },
    cleanupLegacy: cleanup,
    socketInUse(socket: string) {
      return readFileSync("/proc/net/unix", "utf8")
        .split("\n")
        .some((line) => /^\S+\s+(?:\S+\s+){6}(.*)$/.exec(line)?.[1] === socket);
    },
  };
}
