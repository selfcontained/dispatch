#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import {
  appendAssistedUpdateMetadataBlock,
  validateAssistedUpdateMetadataJson,
} from "../apps/server/src/release-metadata.js";

type CliOptions = {
  checkOnly: boolean;
  metadataPath: string;
  notesPath?: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawMetadata = await readRequiredFile(
    options.metadataPath,
    "metadata file"
  );
  const validated = validateAssistedUpdateMetadataJson(rawMetadata);
  if (!validated.success) {
    fail(validated.error);
  }

  if (options.checkOnly) {
    return;
  }

  if (!options.notesPath) {
    fail("--notes is required unless --check-only is set");
  }

  const rawNotes = await readRequiredFile(options.notesPath, "release notes");
  const nextNotes = appendAssistedUpdateMetadataBlock(rawNotes, validated.data);
  await writeFile(options.notesPath, nextNotes, "utf8");
}

function parseArgs(argv: string[]): CliOptions {
  let checkOnly = false;
  let metadataPath: string | undefined;
  let notesPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--check-only":
        checkOnly = true;
        break;
      case "--metadata":
        metadataPath = argv[++i];
        break;
      case "--notes":
        notesPath = argv[++i];
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!metadataPath) {
    fail("--metadata is required");
  }

  if (!checkOnly && !notesPath) {
    fail("--notes is required unless --check-only is set");
  }

  return { checkOnly, metadataPath, notesPath };
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`unable to read ${label} at ${path}: ${message}`);
  }
}

function fail(message: string): never {
  console.error(`embed-assisted-update: ${message}`);
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
