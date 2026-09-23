import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { FileLightbox } from "@/components/app/file-lightbox";
import { type FileItem } from "@/components/app/types";
import { type HistoryFile } from "@/hooks/use-agent-history";
import { fileItemQueryKey } from "@/hooks/use-files";

export function DetailTabs({
  files,
  agentId,
}: {
  files: HistoryFile[];
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [lightboxFileId, setLightboxFileId] = useState<number | null>(null);
  const fileIds = useMemo(() => files.map((item) => item.id), [files]);

  useEffect(() => {
    for (const item of files) {
      queryClient.setQueryData<FileItem>(fileItemQueryKey(item.id), {
        id: item.id,
        ownerAgentId: agentId,
        name: item.file_name,
        size: item.size_bytes,
        updatedAt: item.created_at,
        url: `/api/v1/agents/${agentId}/files/${encodeURIComponent(item.file_name)}`,
        description: item.description,
        source: item.source as FileItem["source"],
      });
    }
  }, [agentId, files, queryClient]);

  return (
    <>
      <div className="min-w-0">
        <h3 className="border-b border-border pb-2 text-sm font-medium text-foreground">
          Files {files.length > 0 && `(${files.length})`}
        </h3>
        <div className="pt-3">
          {files.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {files.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setLightboxFileId(m.id)}
                  className="overflow-hidden rounded border border-border bg-muted/20 text-left transition-colors hover:border-foreground/30"
                >
                  {m.source === "screenshot" || m.source === "simulator" ? (
                    <img
                      src={`/api/v1/agents/${agentId}/files/${encodeURIComponent(m.file_name)}`}
                      alt={m.description ?? m.file_name}
                      className="aspect-video w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex aspect-video items-center justify-center text-[10px] text-muted-foreground">
                      {m.source}
                    </div>
                  )}
                  {m.description && (
                    <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                      {m.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No files captured.
            </p>
          )}
        </div>
      </div>

      <FileLightbox
        fileId={lightboxFileId}
        fileIds={fileIds}
        setFileId={setLightboxFileId}
      />
    </>
  );
}
