import { spawn as nodeSpawn } from "node:child_process";

export function browserCommand(
  url: string,
  platform: NodeJS.Platform
): { command: string; args: string[] } {
  // `start` treats its first quoted argument as a window title.
  if (platform === "win32")
    return { command: "cmd.exe", args: ["/c", "start", "", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(
  url: string,
  deps: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {}
): Promise<void> {
  const { command, args } = browserCommand(
    url,
    deps.platform ?? process.platform
  );
  const spawn = deps.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("spawn", () => resolve());
    child.once("error", () => resolve());
    child.unref();
  });
}
