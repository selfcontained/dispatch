/**
 * Generate icon color variants for all predefined colors.
 *
 * Usage:  npx tsx scripts/generate-icon-colors.ts
 *
 * Reads apps/web/public/brand-icon.svg, recolors it for each palette entry,
 * then renders favicon.png, apple-touch-icon.png, pwa-192.png, and pwa-512.png
 * into apps/web/public/icons/{color}/.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PUBLIC_DIR = path.join(REPO_ROOT, "apps/web/public");
const BRAND_ICON_PATH = path.join(PUBLIC_DIR, "brand-icon.svg");
const BRAND_FULL_LOGO_PATH = path.join(PUBLIC_DIR, "brand-full-logo.svg");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons");

// Original fill colors in brand-icon.svg (percentage-based RGB)
const ORIGINAL_PRIMARY = "rgb(7.843137%, 72.54902%, 50.588235%)";
const ORIGINAL_DARK = "rgb(5.098039%, 51.372549%, 34.509804%)";

const COLORS = [
  { id: "teal", primary: "#14B981", dark: "#0D8358" },
  { id: "blue", primary: "#3B82F6", dark: "#2563EB" },
  { id: "purple", primary: "#8B5CF6", dark: "#6D28D9" },
  { id: "red", primary: "#EF4444", dark: "#B91C1C" },
  { id: "orange", primary: "#F97316", dark: "#C2410C" },
  { id: "amber", primary: "#F59E0B", dark: "#B45309" },
  { id: "pink", primary: "#EC4899", dark: "#BE185D" },
  { id: "cyan", primary: "#06B6D4", dark: "#0E7490" },
] as const;

const SIZES = [
  { name: "pwa-512.png", size: 512 },
  { name: "pwa-192.png", size: 192 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "favicon.png", size: 32 },
] as const;

const BACKGROUND_COLOR = "#141414";

async function main() {
  const brandSvg = fs.readFileSync(BRAND_ICON_PATH, "utf-8");
  const brandFullLogoSvg = fs.readFileSync(BRAND_FULL_LOGO_PATH, "utf-8");

  for (const color of COLORS) {
    const colorDir = path.join(ICONS_DIR, color.id);
    fs.mkdirSync(colorDir, { recursive: true });

    // Recolor the brand icon SVG
    const recolored = brandSvg
      .replaceAll(ORIGINAL_PRIMARY, color.primary)
      .replaceAll(ORIGINAL_DARK, color.dark);

    fs.writeFileSync(path.join(colorDir, "brand-icon.svg"), recolored);

    // Recolor the full logo SVG (icon + wordmark)
    const recoloredFullLogo = brandFullLogoSvg
      .replaceAll(ORIGINAL_PRIMARY, color.primary)
      .replaceAll(ORIGINAL_DARK, color.dark);

    fs.writeFileSync(path.join(colorDir, "brand-full-logo.svg"), recoloredFullLogo);

    // Create a composite SVG at 512x512 with dark background + centered icon
    // The brand icon viewBox is 299.347656 x 285.824219
    // In pwa-icon.svg it's placed at x=94 y=106 width=324 height=300
    const compositeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BACKGROUND_COLOR}"/>
  <g transform="translate(94, 106) scale(${324 / 299.347656}, ${300 / 285.824219})">
    ${extractSvgContent(recolored)}
  </g>
</svg>`;

    // Render PNGs at all sizes
    for (const { name, size } of SIZES) {
      await sharp(Buffer.from(compositeSvg))
        .resize(size, size)
        .png()
        .toFile(path.join(colorDir, name));
    }

    console.log(`  Generated: icons/${color.id}/`);
  }

  console.log(`\nDone! ${COLORS.length} color variants in ${ICONS_DIR}`);
}

/** Extract the inner content of the SVG (paths, etc.) without the outer <svg> wrapper */
function extractSvgContent(svg: string): string {
  // Remove XML declaration if present
  let s = svg.replace(/<\?xml[^?]*\?>/, "").trim();
  // Remove outer <svg ...> and </svg>
  s = s.replace(/<svg[^>]*>/, "").replace(/<\/svg>/, "").trim();
  return s;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
