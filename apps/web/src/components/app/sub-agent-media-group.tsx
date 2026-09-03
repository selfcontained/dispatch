import { useId } from "react";
import { useAtom } from "jotai";
import { ChevronRight } from "lucide-react";

import { type MediaFile, type SubAgentMedia } from "@/components/app/types";
import { MediaCardList } from "@/components/app/media-item-card";
import { mediaGroupCollapsedAtomFamily } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * One sub agent's media under its parent. Expanded by default — screenshots
 * are the point of the tab — with the choice persisted per parent/child pair
 * so it survives a rename. Members stay mounted while collapsed: the seen
 * observer keys off the cards, and unmounting would drop an in-flight
 * "seen" for a file the user had just scrolled past.
 */
export function SubAgentMediaGroup({
  group,
  collapseScope,
  animatingMediaKeys,
  openLightbox,
}: {
  group: SubAgentMedia;
  collapseScope: string;
  animatingMediaKeys: Set<string>;
  openLightbox: (file: MediaFile) => void;
}): JSX.Element {
  const [choice, setChoice] = useAtom(
    mediaGroupCollapsedAtomFamily(`${collapseScope}::${group.agent.id}`)
  );
  const collapsed = choice ?? false;
  const unseen = group.files.filter((file) => !file.seen).length;
  const uid = useId();
  const headingId = `media-group-${uid}`;
  const regionId = `media-group-members-${uid}`;

  return (
    <section
      data-testid="sub-agent-media-group"
      data-sub-agent-id={group.agent.id}
      data-media-group-collapsed={collapsed ? "true" : "false"}
      aria-labelledby={headingId}
    >
      <button
        type="button"
        onClick={() => setChoice(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls={regionId}
        data-testid="sub-agent-media-toggle"
        className="flex w-full items-center gap-1.5 border-b-2 border-border bg-muted/40 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            !collapsed && "rotate-90"
          )}
          aria-hidden
        />
        <span id={headingId} className="min-w-0 flex-1 truncate normal-case">
          {group.agent.name}
        </span>
        {unseen > 0 ? (
          <span
            className="shrink-0 rounded-full bg-destructive px-1.5 text-[10px] font-semibold tabular-nums text-destructive-foreground"
            data-testid="sub-agent-media-unseen"
          >
            {unseen}
          </span>
        ) : null}
        <span
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums"
          data-testid="sub-agent-media-count"
        >
          {group.files.length}
        </span>
      </button>
      <div id={regionId} hidden={collapsed}>
        <MediaCardList
          files={group.files}
          animatingMediaKeys={animatingMediaKeys}
          openLightbox={openLightbox}
        />
      </div>
    </section>
  );
}
