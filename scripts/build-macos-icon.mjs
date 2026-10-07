#!/usr/bin/env node
// Reproduce the native icon from the same Dispatch mark used by the web app.
import sharp from "sharp";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "dispatch-icon-"));
try {
  const monochrome = readFileSync(
    path.join(root, "apps/web/public/brand-icon.svg"),
    "utf8"
  ).replace(/fill="(?!none")[^"]*"/g, 'fill="#000000"');
  for (const scale of [1, 2]) {
    await sharp(Buffer.from(monochrome), { density: 384 })
      .resize(18 * scale, 18 * scale, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(
        path.join(
          root,
          `apps/macos/Resources/DispatchMenuTemplate${scale === 2 ? "@2x" : ""}.png`
        )
      );
  }
  const iconset = path.join(temporary, "Dispatch.iconset");
  mkdirSync(iconset);
  const mark = await sharp(path.join(root, "apps/web/public/brand-icon.svg"), {
    density: 384,
  })
    .resize(650, 650, { fit: "inside" })
    .png()
    .toBuffer();
  const background = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="#141414"/></svg>'
  );
  const master = await sharp(background)
    .composite([{ input: mark, gravity: "centre" }])
    .png()
    .toBuffer();
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await sharp(master)
        .resize(size * scale, size * scale)
        .png()
        .toFile(
          path.join(
            iconset,
            `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`
          )
        );
    }
  }
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(root, "apps/macos/Resources/Dispatch.icns"),
  ]);
  if (process.argv[2])
    await sharp(master).toFile(path.resolve(process.argv[2]));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
