import { toast } from "sonner";

import { isAcceptedUploadFile, uploadAgentMedia } from "@/lib/media-upload";

// Unified upload for both drag-and-drop and clipboard paste. The server
// handles delivery (clipboard injection or typed path) via the `inject`
// flag — the client just uploads and lets the server decide.
//
// Extracted from useTerminal so the hook body stays focused on the terminal
// connection lifecycle. Takes the currently-connected agent id (or null) plus
// a setter for the "uploading" UI flag, and orchestrates validation, upload,
// and toast feedback.
export function uploadTerminalFiles(
  agentId: string | null,
  files: File[],
  setUploadingFiles: (uploading: boolean) => void
): void {
  if (files.length === 0) return;
  if (!agentId) {
    toast.error("Connect to an agent before uploading files.");
    return;
  }
  const accepted = files.filter((file) => isAcceptedUploadFile(file.name));
  const skipped = files.filter((file) => !isAcceptedUploadFile(file.name));
  if (accepted.length === 0) {
    toast.error(
      files.length === 1
        ? `Unsupported file type: ${files[0].name}`
        : "None of the dropped files are a supported type."
    );
    return;
  }
  if (skipped.length > 0) {
    toast.info(
      `Skipped ${skipped.length} unsupported file${
        skipped.length > 1 ? "s" : ""
      }: ${skipped.map((file) => file.name).join(", ")}`
    );
  }
  setUploadingFiles(true);
  void (async () => {
    const failures: string[] = [];
    try {
      for (const file of accepted) {
        try {
          await uploadAgentMedia(agentId, file, { inject: true });
        } catch (err) {
          console.warn(`Upload failed for ${file.name}:`, err);
          failures.push(file.name);
        }
      }
    } finally {
      setUploadingFiles(false);
    }
    if (failures.length > 0) {
      toast.error(
        failures.length === 1
          ? `Failed to upload ${failures[0]}.`
          : `Failed to upload ${failures.length} files.`
      );
    }
  })();
}
