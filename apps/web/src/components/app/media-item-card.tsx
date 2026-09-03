import { FileText, MonitorPlay, User } from "lucide-react";

import { type MediaFile } from "@/components/app/types";
import { MediaActions } from "@/components/app/media-lightbox";
import {
  fileExtension,
  isTextFile,
  stripTimestamp,
} from "@/components/app/media-file-utils";
import { cn } from "@/lib/utils";

export function MediaItemCard({
  file,
  animating,
  cacheBustUrl,
  openLightbox,
}: {
  file: MediaFile;
  animating: boolean;
  cacheBustUrl: string;
  openLightbox: (file: MediaFile) => void;
}): JSX.Element {
  const isStream = file.source === "stream";
  const isText = file.source === "text" || isTextFile(file.name);
  const isDocument = /\.pdf$/i.test(file.name);
  const isUser = file.source === "user";
  const unseen = !file.seen;

  return (
    <article
      data-media-key={`${file.name}:${file.updatedAt}`}
      // Whose file this is, so seen-tracking posts to the owning agent when
      // the card scrolls into view inside a parent's panel.
      data-media-owner={file.ownerAgentId}
      className={cn(
        "border-b-2 border-border px-3 py-3",
        isStream && "border-l-2 border-l-status-blocked/60 bg-status-blocked/5",
        animating && "animate-media-in-slow"
      )}
    >
      {isStream ? (
        <div className="mb-2 flex items-center gap-1.5">
          <MonitorPlay className="h-3.5 w-3.5 text-status-blocked" />
          <span className="text-xs font-semibold uppercase tracking-wide text-status-blocked">
            Stream recording
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(file.updatedAt).toLocaleString()}
          </span>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{new Date(file.updatedAt).toLocaleString()}</span>
          {isUser ? (
            <span className="ml-auto flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <User className="h-2.5 w-2.5" />
              Shared by you
            </span>
          ) : null}
        </div>
      )}
      {isText || isDocument ? (
        <button
          className={cn(
            "block w-full overflow-hidden rounded border-2 bg-muted/50 p-3 text-left",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
          onClick={() => openLightbox(file)}
        >
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 flex-none text-muted-foreground" />
            <span className="truncate text-xs font-medium text-foreground">
              {stripTimestamp(file.name)}
            </span>
            <span className="ml-auto flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {fileExtension(file.name).replace(".", "")}
            </span>
          </div>
        </button>
      ) : /\.mp4$/i.test(file.name) ? (
        <div
          className={cn(
            "block w-full overflow-hidden border-2 bg-black/60",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
        >
          <video
            src={cacheBustUrl}
            controls
            muted
            playsInline
            preload="metadata"
            className="max-h-[260px] w-full object-contain"
          />
        </div>
      ) : (
        <button
          className={cn(
            "block w-full overflow-hidden border-2 bg-black/60",
            unseen ? "media-thumb-unseen" : "media-thumb-seen"
          )}
          onClick={() => openLightbox(file)}
        >
          <img
            src={cacheBustUrl}
            alt={file.description || ""}
            className="max-h-[260px] w-full object-contain"
          />
        </button>
      )}
      <div className="mt-2 text-xs text-muted-foreground">
        {file.description ? <div>{file.description}</div> : null}
        <div
          className={`flex items-center justify-between gap-2${file.description ? " mt-1" : ""}`}
        >
          <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
          <MediaActions
            src={cacheBustUrl}
            fileName={file.name}
            isText={isText}
          />
        </div>
      </div>
    </article>
  );
}

/** The cards for one owner's files, in list order. */
export function MediaCardList({
  files,
  animatingMediaKeys,
  openLightbox,
}: {
  files: MediaFile[];
  animatingMediaKeys: Set<string>;
  openLightbox: (file: MediaFile) => void;
}): JSX.Element {
  return (
    <>
      {files.map((file) => {
        const mediaKey = `${file.name}:${file.updatedAt}`;
        const cacheBustUrl = `${file.url}?t=${encodeURIComponent(file.updatedAt)}`;
        return (
          <MediaItemCard
            key={`${file.ownerAgentId ?? ""}/${mediaKey}`}
            file={file}
            animating={animatingMediaKeys.has(
              `${file.ownerAgentId ?? ""}/${mediaKey}`
            )}
            cacheBustUrl={cacheBustUrl}
            openLightbox={openLightbox}
          />
        );
      })}
    </>
  );
}
