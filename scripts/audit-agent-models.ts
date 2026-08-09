/**
 * Audit AGENT_MODEL_OPTIONS against the locally installed CLIs' own model
 * registries, so the curated catalog can be re-verified mechanically instead
 * of by judgment. Run with:
 *
 *   pnpm tsx scripts/audit-agent-models.ts
 *
 * Exit code 1 means drift: an entry the installed CLIs can't vouch for, an
 * unlabeled entry backed only by per-account evidence, or a past-due
 * retirement. Informational notes (e.g. registry models missing from the
 * catalog) never fail the run — adding models stays a human decision; this
 * script only guarantees what we ship is real.
 *
 * Evidence rules (see docs/agent-model-catalog.md):
 * - Codex: an id must appear in the CLI binary's embedded registry
 *   (install-wide) to ship unlabeled; ids found only in the per-account
 *   ~/.codex/models_cache.json must carry a qualifier like "(preview)".
 * - Claude: each id must appear as a quoted string in the claude binary
 *   (covers both moving aliases and full model ids).
 * - Cursor/opencode: expected to have no catalog entries. If Cursor entries
 *   are ever added, each must appear in `cursor-agent --list-models` output
 *   for the logged-in account.
 */
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_MODEL_OPTIONS } from "../apps/server/src/shared/agent-models.js";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");

const drift: string[] = [];
const notes: string[] = [];

function which(command: string): string | null {
  try {
    const found = execFileSync("which", [command], { encoding: "utf8" }).trim();
    return found ? realpathSync(found) : null;
  } catch {
    return null;
  }
}

/** Stream a (potentially huge) binary and collect regex matches without
 * loading it into memory. Keeps a small carry between chunks so matches
 * spanning a chunk boundary aren't missed. */
async function scanBinary(
  path: string,
  pattern: RegExp,
  group = 1
): Promise<Set<string>> {
  const matches = new Set<string>();
  const carrySize = 1024;
  let carry = "";
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of stream) {
    const text = carry + (chunk as Buffer).toString("latin1");
    for (const match of text.matchAll(pattern)) {
      matches.add(match[group]);
    }
    carry = text.slice(-carrySize);
  }
  return matches;
}

async function auditCodex(): Promise<void> {
  const entries = AGENT_MODEL_OPTIONS.codex ?? [];
  const binary = which("codex");
  if (!binary) {
    if (entries.length > 0) {
      drift.push("codex: CLI not installed but the catalog has codex entries");
    }
    return;
  }

  const embedded = await scanBinary(binary, /"slug":\s*"([^"]+)"/g);

  const cache = new Map<string, string | undefined>();
  const cachePath = join(homedir(), ".codex", "models_cache.json");
  if (existsSync(cachePath)) {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models?: Array<{ slug?: string; visibility?: string }>;
    };
    for (const model of parsed.models ?? []) {
      if (model.slug) cache.set(model.slug, model.visibility);
    }
  } else {
    notes.push(`codex: no ${cachePath} — per-account checks skipped`);
  }

  for (const { id, label } of entries) {
    if (embedded.has(id)) continue;
    if (cache.has(id)) {
      if (!/\(preview\)|\(beta\)/i.test(label)) {
        drift.push(
          `codex: "${id}" is only in the per-account cache; label "${label}" needs a qualifier like "(preview)" or the entry should wait for the embedded registry`
        );
      }
      continue;
    }
    drift.push(
      `codex: "${id}" is in neither the embedded registry nor the account cache — likely retired or misspelled`
    );
  }

  const catalogIds = new Set(entries.map((entry) => entry.id));
  for (const [slug, visibility] of cache) {
    if (visibility === "list" && !catalogIds.has(slug)) {
      notes.push(`codex: registry lists "${slug}" but the catalog omits it`);
    }
  }
}

async function auditClaude(): Promise<void> {
  const entries = AGENT_MODEL_OPTIONS.claude ?? [];
  if (entries.length === 0) return;
  const binary = which("claude");
  if (!binary) {
    drift.push("claude: CLI not installed but the catalog has claude entries");
    return;
  }
  const quoted = await scanBinary(binary, /['"]([a-z][a-z0-9.-]{2,40})['"]/g);
  for (const { id } of entries) {
    if (!quoted.has(id)) {
      drift.push(
        `claude: "${id}" does not appear as a quoted string in the claude binary — check it is still an accepted alias/model id`
      );
    }
  }
}

function auditCursor(): void {
  const entries = AGENT_MODEL_OPTIONS.cursor ?? [];
  if (entries.length === 0) return;
  let listed = "";
  try {
    listed = execFileSync("cursor-agent", ["--list-models"], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch {
    drift.push(
      "cursor: catalog has cursor entries but `cursor-agent --list-models` failed — remove the entries or run on a logged-in account"
    );
    return;
  }
  for (const { id } of entries) {
    if (!listed.includes(id)) {
      drift.push(
        `cursor: "${id}" is not in \`cursor-agent --list-models\` output`
      );
    }
  }
}

function auditRetirements(): void {
  const docs = readFileSync(
    join(repoRoot, "docs", "agent-model-catalog.md"),
    "utf8"
  );
  const section = docs.split("## Known upcoming retirements")[1] ?? "";
  const today = new Date();
  for (const match of section.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g)) {
    const date = new Date(`${match[1]}T00:00:00Z`);
    const daysAway = Math.floor(
      (date.getTime() - today.getTime()) / 86_400_000
    );
    if (daysAway < 0) {
      drift.push(
        `retirements: ${match[1]} has passed — prune the affected entries (docs/agent-model-catalog.md § Known upcoming retirements)`
      );
    } else if (daysAway <= 14) {
      notes.push(`retirements: ${match[1]} is ${daysAway} day(s) away`);
    }
  }
}

await auditCodex();
await auditClaude();
auditCursor();
auditRetirements();

if (notes.length > 0) {
  console.log("Notes (informational):");
  for (const note of notes) console.log(`  - ${note}`);
}
if (drift.length > 0) {
  console.error("Catalog drift detected:");
  for (const item of drift) console.error(`  - ${item}`);
  process.exit(1);
}
console.log("Catalog matches the installed CLI registries.");
