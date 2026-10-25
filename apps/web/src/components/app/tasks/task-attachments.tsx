import { fileMedia } from "@dispatch/shared";
import { useState } from "react";
import type { TaskAttachment } from "../../../../../server/src/tasks/types";
import type { FileItem } from "../types";
import { FileAttachment } from "../chat/chat-attachment-views";
import { FileLightbox } from "../file-lightbox";

export function TaskAttachments({
  attachments,
  updatedAt,
}: {
  attachments: TaskAttachment[];
  updatedAt: string;
}) {
  const [fileId, setFileId] = useState<number | null>(null);
  const files: FileItem[] = attachments.map((file) => ({
    ...file,
    updatedAt,
    media: fileMedia(file.mimeType),
  }));
  return (
    <>
      <div className="flex flex-wrap gap-3">
        {files.map((file) => (
          <FileAttachment
            key={file.id}
            ownerAgentId=""
            url={file.url}
            attachment={{
              type: "file",
              fileId: file.id,
              fileName: file.name,
              sizeBytes: file.size,
              mimeType: file.mimeType,
              media: file.media,
            }}
            ctx={{
              agentId: "",
              agentName: "",
              onOpenFile: (id) => setFileId(id),
            }}
          />
        ))}
      </div>
      <FileLightbox
        files={files}
        fileId={fileId}
        fileIds={files.map((file) => file.id)}
        setFileId={setFileId}
      />
    </>
  );
}
