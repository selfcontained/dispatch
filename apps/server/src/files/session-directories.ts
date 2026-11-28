import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export function ensureDeliveryDirectory(directory: string) {
  return mkdir(directory, { recursive: true });
}
export function removeDeliveryDirectory(directory: string) {
  return rm(directory, { recursive: true, force: true });
}
export function removeHostState(root: string, agentId: string) {
  return rm(path.join(root, agentId), { recursive: true, force: true });
}
