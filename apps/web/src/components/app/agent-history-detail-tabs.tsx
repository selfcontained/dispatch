import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { MediaLightbox } from "@/components/app/media-lightbox";
import { stripTimestamp } from "@/components/app/media-file-utils";
import { PinList } from "@/components/app/pins-panel";
import { type AgentPin } from "@/components/app/types";
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
  const [tab, setTab] = useState<DetailTab>("events");
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const lightboxItems = useMemo(
    () =>
      media.map((m) => ({
        src: `/api/v1/agents/${agentId}/media/${encodeURIComponent(m.file_name)}`,
        caption: m.description ?? stripTimestamp(m.file_name),
        file: {
          name: m.file_name,
          size: m.size_bytes,
          updatedAt: m.created_at,
          source: m.source as "screenshot" | "stream" | "text",
        },
      })),
    [media, agentId]
  );

  const lightboxItem =
    lightboxIndex !== null ? (lightboxItems[lightboxIndex] ?? null) : null;

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
              {media.map((m, i) => (
                <button
                  key={m.file_name}
                  onClick={() => setLightboxIndex(i)}
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
        item={lightboxItem}
        currentIndex={lightboxIndex ?? 0}
        totalItems={lightboxItems.length}
        setLightboxIndex={setLightboxIndex}
      />
    </>
  );
}
