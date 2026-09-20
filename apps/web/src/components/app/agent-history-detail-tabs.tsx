import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { FileLightbox } from "@/components/app/file-lightbox";
import { type FileItem } from "@/components/app/types";
import { type HistoryEvent, type HistoryFile } from "@/hooks/use-agent-history";
import { EventTimeline } from "@/components/app/agent-history-timeline";
import { fileItemQueryKey } from "@/hooks/use-files";

type DetailTab = "events" | "files";

export function DetailTabs({
  events,
  files,
  agentId,
}: {
  events: HistoryEvent[];
  files: HistoryFile[];
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("events");
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

  const tabs: Array<{ key: DetailTab; label: string; count: number }> = [
    { key: "events", label: "Events", count: events.length },
    { key: "files", label: "Files", count: files.length },
  ];

  return (
    <>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border pb-0">
          {tabs.map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "relative shrink-0 px-3 py-1.5 text-xs font-medium transition-colors",
                tab === key
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
              {count > 0 && (
                <span
                  className={cn(
                    "ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium",
                    tab === key
                      ? "bg-foreground/15 text-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {count}
                </span>
              )}
              {tab === key && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-foreground" />
              )}
            </button>
          ))}
        </div>

        <div className="pt-3">
          {tab === "events" && events.length > 0 && (
            <EventTimeline events={events} />
          )}
          {tab === "events" && events.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No events recorded.
            </p>
          )}

          {tab === "files" && files.length > 0 && (
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
          )}
          {tab === "files" && files.length === 0 && (
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
