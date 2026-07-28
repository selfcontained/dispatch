// File-type tables live in the shared server module so the server's upload
// validation and the web viewers can never drift apart.
export {
  fileExtension,
  isTextFile,
} from "../../../../server/src/shared/media-file-types";

const TIMESTAMP_RE = /-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d+/;

export function stripTimestamp(name: string): string {
  return name.replace(TIMESTAMP_RE, "");
}
