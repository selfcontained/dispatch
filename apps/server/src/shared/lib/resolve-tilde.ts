import os from "node:os";
import path from "node:path";

export function resolveTilde(value: string): string {
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value === "~") return os.homedir();
  return value;
}
