import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { PinList } from "@/components/app/pins-panel";
import { type AgentPin, type MediaFile } from "@/components/app/types";
import {
  type HistoryEvent,
  type HistoryFeedbackItem,
  type HistoryMedia,
} from "@/hooks/use-agent-history";
import {
  EventTimeline,
  FeedbackTimeline,
} from "@/components/app/agent-history-timeline";
import { HistoryMessages } from "@/components/app/agent-history-messages";
import { type AgentMessage } from "@/hooks/use-agent-messages";
import { mediaItemQueryKey } from "@/hooks/use-media";

type DetailTab = "events" | "media" | "pins" | "feedback" | "messages";

export function DetailTabs({
  events,
  media,
  pins,
  feedback,
  messages,
  agentId,
  workspaceRoot,
}: {
  events: HistoryEvent[];
  media: HistoryMedia[];
  pins: AgentPin[];
  feedback: HistoryFeedbackItem[];
  messages: AgentMessage[];
  agentId: string;
  workspaceRoot: string | null;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("events");
  const [lightboxMediaId, setLightboxMediaId] = useState<number | null>(null);
  const mediaIds = useMemo(() => media.map((item) => item.id), [media]);

  useEffect(() => {
    for (const item of media) {
      queryClient.setQueryData<MediaFile>(mediaItemQueryKey(item.id), {
        id: item.id,
        ownerAgentId: agentId,
        name: item.file_name,
        size: item.size_bytes,
        updatedAt: item.created_at,
        url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(item.file_name)}`,
        description: item.description,
        source: item.source as MediaFile["source"],
      });
    }
  }, [agentId, media, queryClient]);

  const tabs: Array<{ key: DetailTab; label: string; count: number }> = [
    { key: "events", label: "Events", count: events.length },
    { key: "media", label: "Media", count: media.length },
    { key: "pins", label: "Pins", count: pins.length },
    { key: "feedback", label: "Feedback", count: feedback.length },
    { key: "messages", label: "Messages", count: messages.length },
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

          {tab === "media" && media.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {media.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setLightboxMediaId(m.id)}
                  className="overflow-hidden rounded border border-border bg-muted/20 text-left transition-colors hover:border-foreground/30"
                >
                  {m.source === "screenshot" || m.source === "simulator" ? (
                    <img
                      src={`/api/v1/agents/${agentId}/media/${encodeURIComponent(m.file_name)}`}
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
          {tab === "media" && media.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No media captured.
            </p>
          )}

          {tab === "pins" && pins.length > 0 && (
            <div className="divide-y divide-border rounded-md border border-border">
              <PinList
                pins={pins}
                workspaceRoot={workspaceRoot}
                collapseScope={agentId}
              />
            </div>
          )}
          {tab === "pins" && pins.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No pins recorded.
            </p>
          )}

          {tab === "feedback" && feedback.length > 0 && (
            <FeedbackTimeline feedback={feedback} />
          )}
          {tab === "feedback" && feedback.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No feedback received.
            </p>
          )}

          {tab === "messages" && messages.length > 0 && (
            <HistoryMessages messages={messages} agentId={agentId} />
          )}
          {tab === "messages" && messages.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No messages recorded.
            </p>
          )}
        </div>
      </div>

      <MediaLightbox
        mediaId={lightboxMediaId}
        mediaIds={mediaIds}
        setMediaId={setLightboxMediaId}
      />
    </>
  );
}
