/* Regenerates launcher-surface.json from the launcher schema. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launcherSurface } from "../src/launcher/schema.js";

const target = fileURLToPath(
  new URL("../launcher-surface.json", import.meta.url)
);
writeFileSync(target, JSON.stringify(launcherSurface(), null, 2) + "\n");
