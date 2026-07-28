import { api } from "@/lib/api";
import { STARTUP_FILE_ACCEPT } from "@/lib/media-accept";

export { STARTUP_FILE_ACCEPT };

/** Source tag stored alongside an uploaded media file. */
export type MediaUploadSource =
  | "screenshot"
  | "stream"
  | "simulator"
  | "text"
  | "user";

export type UploadedMedia = {
  id: number;
  fileName: string;
  source: string;
  sizeBytes: number;
  createdAt: string;
  /** URL for fetching the file back through the API. */
  url: string;
  /**
   * Absolute path of the saved file on the *server's* filesystem. Server-local
   * detail — only meaningful for same-host consumers (the terminal feature
   * types it into the CLI prompt so the agent, which runs on the same host, can
   * open it). NOT a stable client contract; do not surface it in the browser or
   * depend on it from other media consumers.
   */
  path: string;
  /** How the server delivered the file to the agent session. */
  delivery: "none" | "clipboard" | "path";
};

/** Lower-cased extensions (with leading dot) the upload endpoint accepts. */
const ACCEPTED_EXTENSIONS = new Set(
  STARTUP_FILE_ACCEPT.split(",").map((ext) => ext.trim().toLowerCase())
);

/**
 * Whether the upload endpoint will accept this file based on its extension.
 * The server validates authoritatively via isMediaFile(); this is a cheap
 * client-side pre-filter so we don't fire obviously-doomed requests.
 */
export function isAcceptedUploadFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  return ACCEPTED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Upload a single file to an agent's media store. Writes the file on the
 * server (under the agent's media dir), records it in the media DB, and
 * returns the saved metadata — including the absolute server path, which
 * callers can type into the terminal so the CLI can read the file.
 *
 * When `opts.inject` is true the server also delivers the file to the
 * agent's terminal session (clipboard or typed path, depending on the
 * host's capabilities and the file type).
 */
export async function uploadAgentMedia(
  agentId: string,
  file: File,
  opts: { source?: MediaUploadSource; inject?: boolean } = {}
): Promise<UploadedMedia> {
  const form = new FormData();
  form.append("source", opts.source ?? "user");
  if (opts.inject) form.append("inject", "true");
  form.append("file", file, file.name);
  const res = await api<{ ok: true; media: UploadedMedia }>(
    `/api/v1/agents/${agentId}/media`,
    { method: "POST", body: form }
  );
  return res.media;
}

export { extensionForMime } from "../../../server/src/shared/media-file-types";
