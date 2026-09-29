#!/usr/bin/env node
// Assemble the optional macOS preview without changing the Linux release pipeline.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import {
  downloadPostgres,
  verifyPostgres,
} from "./download-macos-postgres.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
  return result.stdout?.trim();
}

if (process.platform !== "darwin")
  throw new Error(
    "Build the Mac app on macOS with the Swift toolchain installed."
  );
const version = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8")
).version;
const arch = process.env.DISPATCH_MAC_ARCH ?? process.arch;
if (!["arm64", "x64"].includes(arch))
  throw new Error("DISPATCH_MAC_ARCH must be arm64 or x64");
const swiftArch = arch === "x64" ? "x86_64" : "arm64";
const binary = path.resolve(
  process.env.DISPATCH_MAC_SERVER_BINARY ??
    path.join(root, "dist/bun", `dispatch-${version}-bun-darwin-${arch}`)
);
if (!existsSync(binary))
  throw new Error(
    `Missing server binary: ${binary}. Run build:bun for bun-darwin-${arch} first.`
  );
run("lipo", [binary, "-verify_arch", swiftArch]);
const output = path.join(root, "dist/macos", arch);
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(output, ".package-"));
const appName = "Dispatch.app";
const app = path.join(temporary, appName);
const contents = path.join(app, "Contents");
const identity = process.env.DISPATCH_CODESIGN_IDENTITY;
const notarize = process.env.DISPATCH_NOTARIZE_MACOS_APP === "1";
if (notarize && (!identity || !process.env.DISPATCH_NOTARY_KEYCHAIN_PROFILE)) {
  throw new Error(
    "Notarization requires DISPATCH_CODESIGN_IDENTITY and DISPATCH_NOTARY_KEYCHAIN_PROFILE."
  );
}
try {
  const swiftArgs = [
    "--package-path",
    "apps/macos",
    "--configuration",
    "release",
    "--triple",
    `${swiftArch}-apple-macosx13.0`,
  ];
  run("swift", ["build", ...swiftArgs]);
  const buildPath = run("swift", ["build", ...swiftArgs, "--show-bin-path"], {
    stdio: "pipe",
    encoding: "utf8",
  });
  for (const directory of ["MacOS", "Helpers", "Library/LaunchAgents"])
    mkdirSync(path.join(contents, directory), { recursive: true });
  cpSync(
    path.join(buildPath, "DispatchMenu"),
    path.join(contents, "MacOS/DispatchMenu")
  );
  cpSync(binary, path.join(contents, "Helpers/dispatch"));
  const postgres = await downloadPostgres(
    arch,
    path.join(contents, "Helpers/Postgres")
  );
  // Helpers is a nested-code location. Keep PostgreSQL's data/source notices in
  // Resources and link the standard runtime layout to it for relocatability.
  const postgresResources = path.join(contents, "Resources/Postgres");
  mkdirSync(postgresResources, { recursive: true });
  cpSync(
    path.join(root, "apps/macos/Resources/Dispatch.icns"),
    path.join(contents, "Resources/Dispatch.icns")
  );
  for (const name of [
    "DispatchMenuTemplate.png",
    "DispatchMenuTemplate@2x.png",
  ]) {
    cpSync(
      path.join(root, "apps/macos/Resources", name),
      path.join(contents, "Resources", name)
    );
  }
  for (const name of ["share", "licenses", "SOURCE.json"]) {
    renameSync(path.join(postgres, name), path.join(postgresResources, name));
    symlinkSync(`../../Resources/Postgres/${name}`, path.join(postgres, name));
  }
  cpSync(
    path.join(root, "apps/macos/Resources/Info.plist"),
    path.join(contents, "Info.plist")
  );
  cpSync(
    path.join(
      root,
      "apps/macos/Resources/dev.bradharris.dispatch.preview.server.plist"
    ),
    path.join(
      contents,
      "Library/LaunchAgents/dev.bradharris.dispatch.preview.server.plist"
    )
  );
  const build = process.env.DISPATCH_MAC_BUILD ?? "1";
  if (!/^\d+(\.\d+){0,2}$/.test(build))
    throw new Error("DISPATCH_MAC_BUILD must be a numeric bundle version.");
  run("plutil", [
    "-replace",
    "CFBundleShortVersionString",
    "-string",
    version,
    path.join(contents, "Info.plist"),
  ]);
  run("plutil", [
    "-replace",
    "CFBundleVersion",
    "-string",
    build,
    path.join(contents, "Info.plist"),
  ]);
  // Sign nested code first; Bun needs JIT entitlements, the native shell does not.
  const signing = [
    "--force",
    "--sign",
    identity ?? "-",
    ...(identity ? ["--options", "runtime", "--timestamp"] : []),
  ];
  // Sign every nested PostgreSQL Mach-O, deepest libraries first. Never rely on
  // --deep signing: each binary must receive the same Developer ID/runtime flags.
  const postgresCode = verifyPostgres(postgres, arch).sort(
    (a, b) =>
      Number(a.includes(`${path.sep}bin${path.sep}`)) -
        Number(b.includes(`${path.sep}bin${path.sep}`)) ||
      b.split(path.sep).length - a.split(path.sep).length ||
      a.localeCompare(b)
  );
  for (const file of postgresCode) run("codesign", [...signing, file]);
  run("codesign", [
    ...signing,
    "--identifier",
    "dev.bradharris.dispatch.preview.runtime",
    "--entitlements",
    path.join(root, "scripts/dispatch-bun.entitlements.plist"),
    path.join(contents, "Helpers/dispatch"),
  ]);
  run("codesign", [...signing, app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const zipName = `dispatch-macos-preview-${version}-${arch}.zip`;
  const zip = path.join(temporary, zipName);
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  if (notarize) {
    run("xcrun", [
      "notarytool",
      "submit",
      zip,
      "--keychain-profile",
      process.env.DISPATCH_NOTARY_KEYCHAIN_PROFILE,
      ...(process.env.DISPATCH_NOTARY_KEYCHAIN
        ? ["--keychain", process.env.DISPATCH_NOTARY_KEYCHAIN]
        : []),
      "--wait",
    ]);
    run("xcrun", ["stapler", "staple", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "execute", "--verbose", app]);
    rmSync(zip);
    run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  }
  const finalApp = path.join(output, appName);
  rmSync(finalApp, { recursive: true, force: true });
  renameSync(app, finalApp);
  renameSync(zip, path.join(output, zipName));
  console.log(
    `${notarize ? "Notarized" : identity ? "Signed, not notarized" : "Local ad-hoc"} preview: ${finalApp}`
  );
  console.log(`Archive: ${path.join(output, zipName)}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
