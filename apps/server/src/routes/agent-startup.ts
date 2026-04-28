import path from "node:path";

import { validatePinValue } from "../pins.js";
import { isMediaFile, isTextFile } from "../shared/media.js";

export type CreateAgentBody = {
  name?: unknown;
  type?: unknown;
  cwd?: unknown;
  agentArgs?: unknown;
  codexArgs?: unknown;
  fullAccess?: unknown;
  useWorktree?: unknown;
  createNewBranch?: unknown;
  worktreeBranch?: unknown;
  baseBranch?: unknown;
  persona?: unknown;
  parentAgentId?: unknown;
  personaContext?: unknown;
  autoReview?: unknown;
  initialPrompt?: unknown;
  startupLinks?: unknown;
};

export type StartupFileUpload = {
  fileName: string;
  originalName: string;
  buffer: Buffer;
  source: "text" | "user";
  description: string | null;
};

export const MAX_STARTUP_FILE_COUNT = 10;
const MAX_STARTUP_FILE_NAME_LENGTH = 128;

export function parseOptionalBooleanField(
  value: unknown,
  fieldName: string,
  allowStringCoercion: boolean
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (allowStringCoercion && value === "true") return true;
  if (allowStringCoercion && value === "false") return false;
  throw new Error(`${fieldName} must be a boolean when provided.`);
}

export function parseOptionalStringArrayField(
  value: unknown,
  fieldName: string,
  allowStringCoercion: boolean
): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (!allowStringCoercion || typeof value !== "string") {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {}
  throw new Error(`${fieldName} must be an array of strings.`);
}

export function createStartupPins(urls: string[]): Array<{
  label: string;
  value: string;
  type: "url";
}> {
  const counts = new Map<string, number>();
  return urls.map((rawUrl) => {
    validatePinValue("url", rawUrl);
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "") || "Link";
    const seen = counts.get(hostname) ?? 0;
    counts.set(hostname, seen + 1);
    return {
      label: seen === 0 ? hostname : `${hostname} ${seen + 1}`,
      value: rawUrl,
      type: "url",
    };
  });
}

function sanitizeUploadedFileName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const baseName = path.basename(name, ext).normalize("NFKD");
  const collapsed = baseName
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._() -]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${collapsed || "file"}${ext}`;
}

function sanitizeStartupDisplayName(
  name: string | undefined,
  fallback: string
): string {
  const normalized = path
    .basename(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, MAX_STARTUP_FILE_NAME_LENGTH);
}

export async function parseCreateAgentRequest(request: {
  body?: unknown;
  isMultipart: () => boolean;
  parts: () => AsyncIterable<unknown>;
}): Promise<{
  body: CreateAgentBody;
  startupFiles: StartupFileUpload[];
  isMultipart: boolean;
}> {
  const multipart = request.isMultipart();
  if (!multipart) {
    return {
      body: (request.body as CreateAgentBody | undefined) ?? {},
      startupFiles: [],
      isMultipart: false,
    };
  }

  const body: CreateAgentBody = {};
  const startupFiles: StartupFileUpload[] = [];

  for await (const rawPart of request.parts()) {
    const part = rawPart as {
      type: "file" | "field";
      fieldname: string;
      filename?: string;
      value?: unknown;
      toBuffer?: () => Promise<Buffer>;
    };
    if (part.type === "file") {
      if (part.fieldname !== "startupFiles") {
        throw new Error("Unexpected file field.");
      }
      if (startupFiles.length >= MAX_STARTUP_FILE_COUNT) {
        throw new Error(
          `A maximum of ${MAX_STARTUP_FILE_COUNT} startup files is allowed.`
        );
      }
      const fileName = sanitizeUploadedFileName(
        path.basename(part.filename || "")
      );
      if (!fileName) {
        throw new Error("Invalid file name.");
      }
      if (!isMediaFile(fileName)) {
        throw new Error(
          "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc)."
        );
      }
      if (!part.toBuffer) {
        throw new Error("Invalid file upload.");
      }
      startupFiles.push({
        fileName,
        originalName: sanitizeStartupDisplayName(part.filename, fileName),
        buffer: await part.toBuffer(),
        source: isTextFile(fileName) ? "text" : "user",
        description: null,
      });
      continue;
    }

    body[part.fieldname as keyof CreateAgentBody] = part.value;
  }

  return { body, startupFiles, isMultipart: true };
}
