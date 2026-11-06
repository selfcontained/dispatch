import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** An inherited capability, unique to one launch (nested launches retain it). */
export function ownedEnvironment(env) {
  const marker = `DISPATCH_OWNED_${randomUUID().replaceAll("-", "")}=1`;
  const [key, value] = marker.split("=");
  return { marker, env: { ...env, [key]: value } };
}

function members(marker, pid) {
  // -ww prevents truncation on macOS; e includes inherited environments on
  // macOS and Linux. Never log this output: other processes contain secrets.
  let output;
  try {
    output = execFileSync(
      "ps",
      pid
        ? ["eww", "-p", String(pid), "-o", "pid=,command="]
        : process.platform === "linux"
          ? ["axeww", "-o", "pid=,command="]
          : ["eww", "-axo", "pid=,command="],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  } catch (error) {
    if (pid && error.status === 1) return [];
    // execFileSync errors contain stdout (all environments). Never propagate it.
    const stderr = String(error.stderr ?? "")
      .replace(/[A-Za-z_][A-Za-z0-9_]*=[^\s]*/g, "[redacted assignment]")
      .slice(0, 2048)
      .trim();
    throw new Error(
      `Unable to enumerate owned processes (status=${error.status ?? "none"}, code=${error.code ?? "none"}, signal=${error.signal ?? "none"})${stderr ? `: ${stderr}` : ""}`
    );
  }
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !match[2].split(/\s+/).includes(marker)) return [];
    const memberPid = Number(match[1]);
    if (process.platform === "linux") {
      try {
        // Arguments can contain marker-shaped text. Confirm the actual inherited
        // environment on Linux, including NUL boundaries, before claiming it.
        if (
          !readFileSync(`/proc/${memberPid}/environ`, "utf8")
            .split("\0")
            .includes(marker)
        )
          return [];
      } catch (error) {
        if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code))
          return [];
        throw new Error(
          `Unable to verify owned process ${memberPid} (${error.code})`
        );
      }
    }
    return [memberPid];
  });
}

/** Clean only processes still bearing this launch's capability, even after
 * reparenting or setsid. Bounded rescans catch children forked during teardown.
 * Providers that strip their environment are outside this ownership boundary.
 * Windows requires a Job Object implementation and is not supported here.
 */
export function killOwnedProcesses(marker) {
  if (!/^DISPATCH_OWNED_[a-f0-9]{32}=1$/.test(marker))
    throw new Error("Invalid process ownership marker");
  if (process.platform === "win32") return;
  for (let pass = 0; pass < 3; pass++) {
    const pids = members(marker);
    if (!pids.length) return;
    for (const pid of pids) {
      if (pid === process.pid) continue;
      try {
        // Revalidate the capability immediately before signaling, guarding PID
        // reuse between enumeration and cleanup. Never signal a shared PGID.
        if (members(marker, pid).includes(pid)) process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.status !== 1) throw error;
      }
    }
  }
}
