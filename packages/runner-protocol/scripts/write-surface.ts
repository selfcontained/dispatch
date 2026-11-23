/* Regenerates surface.json from the operation table. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { surface } from "../src/contract/surface.js";

const target = fileURLToPath(new URL("../surface.json", import.meta.url));
writeFileSync(target, JSON.stringify(surface(), null, 2) + "\n");
