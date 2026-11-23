import path from "node:path";

const ICON_EXTENSIONS = new Set([".svg", ".png", ".ico"]);

// Conventional repo-supplied logo, e.g. `.dispatch/logo.png`. Checked before
// the generic scan below (which skips dot-directories entirely) so a repo
// can deliberately opt in without relying on incidental favicon/logo naming
// elsewhere in the tree.
const CONVENTIONAL_LOGO_DIR = ".dispatch";
const CONVENTIONAL_LOGO_BASENAME = "logo";
// Same svg > png > ico preference as EXT_PRIORITY below.
const CONVENTIONAL_LOGO_EXTENSIONS = [".svg", ".png", ".ico"];

/** Where an icon is looked for: a checkout, however it is read. */
export interface IconSource {
  /** Whether the checkout-relative path is a file, following links. */
  isFile(rel: string): Promise<boolean>;
  /** The entries of a checkout-relative directory, or null when unreadable. */
  list(rel: string): Promise<IconEntry[] | null>;
}
export type IconEntry = {
  name: string;
  kind: "file" | "directory" | "link" | "other";
};

async function findConventionalLogo(
  source: IconSource
): Promise<string | null> {
  for (const ext of CONVENTIONAL_LOGO_EXTENSIONS) {
    const rel = path.join(
      CONVENTIONAL_LOGO_DIR,
      `${CONVENTIONAL_LOGO_BASENAME}${ext}`
    );
    // Not found at this extension — try the next.
    if (await source.isFile(rel)) return rel;
  }
  return null;
}

const ICON_NAME_PATTERNS = [
  /^favicon\b/i,
  /^icon\b/i,
  /\bicon\b/i,
  /^brand-icon\b/i,
  /^logo\b/i,
  /\blogo\b/i,
  /^brand\b/i,
];

const EXT_PRIORITY: Record<string, number> = {
  ".svg": 0,
  ".png": 1,
  ".ico": 2,
};
const MAX_SCAN_DEPTH = 4;
const MAX_DIR_ENTRIES = 200;

function iconScore(relPath: string): number {
  const name = path.basename(relPath, path.extname(relPath)).toLowerCase();
  const ext = path.extname(relPath).toLowerCase();
  const extRank = EXT_PRIORITY[ext] ?? 3;

  let nameRank = ICON_NAME_PATTERNS.length;
  for (let i = 0; i < ICON_NAME_PATTERNS.length; i++) {
    if (ICON_NAME_PATTERNS[i].test(name)) {
      nameRank = i;
      break;
    }
  }

  const depth = relPath.split(path.sep).length - 1;
  return nameRank * 100 + extRank * 10 + depth;
}

async function scanForIcons(
  source: IconSource,
  rel: string,
  depth: number,
  results: string[]
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) return;
  const entries = await source.list(rel);
  if (!entries) return;
  if (entries.length > MAX_DIR_ENTRIES) return;

  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build"
    )
      continue;

    if (
      entry.kind === "file" &&
      ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      const nameLower = entry.name.toLowerCase();
      if (
        ICON_NAME_PATTERNS.some((p) =>
          p.test(path.basename(nameLower, path.extname(nameLower)))
        )
      ) {
        results.push(childRel);
      }
    } else if (entry.kind === "directory") {
      await scanForIcons(source, childRel, depth + 1, results);
    }
  }
}

export async function detectIconFrom(
  source: IconSource
): Promise<string | null> {
  const conventional = await findConventionalLogo(source);
  if (conventional) return conventional;

  const candidates: string[] = [];
  await scanForIcons(source, "", 0, candidates);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => iconScore(a) - iconScore(b));
  return candidates[0];
}
