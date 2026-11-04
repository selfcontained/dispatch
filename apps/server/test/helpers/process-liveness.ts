import { readFileSync } from "node:fs";

/** A zombie has exited, even when a container's PID 1 never reaps it. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The parenthesized comm field can contain spaces and closing parentheses.
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
