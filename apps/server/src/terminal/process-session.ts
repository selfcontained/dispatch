import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let darwinGetSid: ((pid: number) => number) | undefined;

/** macOS ps masks its kernel session pointers, so ask the POSIX syscall. */
function getSessionId(pid: number): number {
  if (process.platform === "darwin") {
    if (!darwinGetSid) {
      // Lazy and macOS-only: Node tests and other platforms never load FFI.
      // Use only the system library and scalar pid_t ABI; no addon or compiler.
      const { dlopen } = createRequire(import.meta.url)(
        "bun:ffi"
      ) as typeof import("bun:ffi");
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        getsid: { args: ["i32"], returns: "i32" },
      });
      darwinGetSid = library.symbols.getsid;
    }
    return darwinGetSid(pid);
  }
  if (process.platform === "linux") {
    try {
      // /proc stat's comm field can itself contain spaces and parentheses.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return Number(fields[3]); // field 6: session, after pid/comm
    } catch {
      return -1;
    }
  }
  throw new Error(
    "Terminal process sessions are unsupported on this platform."
  );
}

function ps(args: string[]): string {
  return execFileSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Kept separate for deterministic tests of ownership and PID reuse guards. */
export function sessionCleanup(
  sessionId: number,
  serverSessionId: number,
  listPids: () => number[],
  sessionOf: (pid: number) => number,
  signal: (pid: number) => void
): () => void {
  if (
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 1 ||
    sessionId === serverSessionId
  )
    throw new Error("Unsafe terminal session identity.");
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    // The kernel retains the session ID while reparented Bash jobs exist.
    // No PPID/TTY snapshot is used, and a reused PID is rechecked before kill.
    for (const pid of listPids()) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
        continue;
      if (sessionOf(pid) !== sessionId) continue;
      try {
        if (sessionOf(pid) === sessionId) signal(pid);
      } catch {
        /* exited */
      }
    }
  };
}

export function captureTerminalSession(pid: number): () => void {
  const ownUid = process.getuid?.();
  const sessionId = getSessionId(pid);
  const serverSessionId = getSessionId(process.pid);
  const identity = ps(["-p", String(pid), "-o", "uid=,tty="])
    .trim()
    .split(/\s+/);
  // Bun's PTY spawn must be its own session leader on a real terminal. Fail
  // closed rather than ever enumerate/signal the Dispatch server's session.
  if (
    sessionId !== pid ||
    serverSessionId <= 0 ||
    Number(identity[0]) !== ownUid ||
    !identity[1] ||
    /^[?]+$/.test(identity[1])
  ) {
    throw new Error("Cannot verify isolated terminal process session.");
  }
  return sessionCleanup(
    sessionId,
    serverSessionId,
    () => {
      return ps(["-axo", "pid=,uid="])
        .trim()
        .split("\n")
        .flatMap((line) => {
          const [candidate, uid] = line.trim().split(/\s+/).map(Number);
          return uid === ownUid ? [candidate] : [];
        });
    },
    getSessionId,
    (pid) => process.kill(pid, "SIGKILL")
  );
}
