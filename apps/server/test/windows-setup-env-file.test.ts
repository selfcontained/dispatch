import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildSetupEnv,
  installDir,
  parseEnvFile,
  renderEnvFile,
  writeEnvFile,
} from "../src/windows-setup/env-file.js";

describe("installDir", () => {
  it("uses LOCALAPPDATA\\Dispatch on Windows", () => {
    expect(
      installDir({ LOCALAPPDATA: "C:\\Users\\nii\\AppData\\Local" }, "win32")
    ).toBe(path.join("C:\\Users\\nii\\AppData\\Local", "Dispatch"));
  });

  it("prefers DISPATCH_SETUP_INSTALL_DIR", () => {
    expect(
      installDir(
        { DISPATCH_SETUP_INSTALL_DIR: "/tmp/x", LOCALAPPDATA: "C:\\a" },
        "win32"
      )
    ).toBe("/tmp/x");
  });

  it("throws off Windows without an override", () => {
    expect(() => installDir({}, "darwin")).toThrow(
      /DISPATCH_SETUP_INSTALL_DIR/
    );
  });
});

describe("env file", () => {
  const input = {
    databaseUrl: "postgres://dispatch:p%40ss@127.0.0.1:5432/dispatch",
    port: 6767,
    installDir: "C:\\Users\\nii\\AppData\\Local\\Dispatch",
  };
  const env = buildSetupEnv(input);

  it("renders keys in the documented order", () => {
    expect(
      renderEnvFile(env)
        .split("\n")
        .map((line) => line.split("=")[0])
    ).toEqual([
      "DATABASE_URL",
      "DISPATCH_HOST",
      "DISPATCH_PORT",
      "DISPATCH_STATE_DIR",
      "DISPATCH_SERVER_DIR",
      "DISPATCH_RUNTIME_PATH",
      "DISPATCH_UPDATE_OWNER",
      "",
    ]);
  });

  it("includes DISPATCH_LISTEN_HOSTS only when set", () => {
    expect(renderEnvFile(env)).not.toContain("DISPATCH_LISTEN_HOSTS");
    expect(
      renderEnvFile(buildSetupEnv({ ...input, listenHosts: "192.168.1.20" }))
    ).toContain("DISPATCH_LISTEN_HOSTS=192.168.1.20\n");
  });

  it("fills the fixed values from the install directory", () => {
    expect(env).toMatchObject({
      DATABASE_URL: input.databaseUrl,
      DISPATCH_HOST: "127.0.0.1",
      DISPATCH_PORT: "6767",
      DISPATCH_STATE_DIR: path.join(input.installDir, "state"),
      DISPATCH_SERVER_DIR: input.installDir,
      DISPATCH_RUNTIME_PATH: path.join(input.installDir, "dispatch.exe"),
      DISPATCH_UPDATE_OWNER: "windows-tray",
    });
  });

  it("round-trips through parseEnvFile", () => {
    expect(parseEnvFile(renderEnvFile(env))).toEqual(env);
    const spaced = buildSetupEnv({
      ...input,
      installDir: "C:\\Users\\Nii Yeboah\\AppData\\Local\\Dispatch",
    });
    expect(parseEnvFile(renderEnvFile(spaced))).toEqual(spaced);
  });

  it("writes atomically via .env.tmp", () => {
    const calls: string[] = [];
    const fs = {
      mkdirSync: vi.fn((dir: string, options: { recursive: boolean }) => {
        calls.push(`mkdir ${dir} ${options.recursive}`);
        return undefined;
      }),
      writeFileSync: vi.fn((file: string) => {
        calls.push(`write ${file}`);
      }),
      renameSync: vi.fn((from: string, to: string) => {
        calls.push(`rename ${from} ${to}`);
      }),
    };
    const dir = "/tmp/dispatch-install";
    writeEnvFile(dir, env, fs);
    expect(calls).toEqual([
      `mkdir ${dir} true`,
      `write ${path.join(dir, ".env.tmp")}`,
      `rename ${path.join(dir, ".env.tmp")} ${path.join(dir, ".env")}`,
    ]);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      path.join(dir, ".env.tmp"),
      renderEnvFile(env),
      "utf8"
    );
  });
});
