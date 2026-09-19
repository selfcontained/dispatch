import path from "node:path";

import {
  isMediaFile,
  isTextFile,
  sanitizeUploadedFileName,
} from "../shared/media.js";

export type CreateAgentBody = {
  name?: unknown;
  type?: unknown;
  model?: unknown;
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

const MAX_STARTUP_LINKS = 20;
const MAX_STARTUP_LINK_LENGTH = 2000;

/**
 * Startup links become link attachments on the launch post and lines in the
 * first turn, so each has to be an absolute http(s) URL. Returns the trimmed
 * list; throws a plain Error the route reports as a 400.
 */
export function validateStartupLinks(urls: string[]): string[] {
  const links = urls.map((url) => url.trim()).filter((url) => url.length > 0);
  if (links.length > MAX_STARTUP_LINKS) {
    throw new Error(
      `A maximum of ${MAX_STARTUP_LINKS} startup links is allowed.`
    );
  }
  for (const link of links) {
    if (link.length > MAX_STARTUP_LINK_LENGTH) {
      throw new Error(
        `Startup links must be at most ${MAX_STARTUP_LINK_LENGTH} characters.`
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      throw new Error(`Startup link is not a valid URL: ${link}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Startup link must be an http or https URL: ${link}`);
    }
  }
  return links;
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
