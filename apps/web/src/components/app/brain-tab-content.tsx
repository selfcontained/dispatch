import { Link } from "react-router-dom";
import { ArrowRight, Brain, Database, List, Radio } from "lucide-react";

import { useAgentBrainActivity } from "@/hooks/use-brain";
import { encodeRepoRoot } from "@/lib/brain-encoding";
import { cn } from "@/lib/utils";
import {
  CollapsibleSection,
  ObjectCard,
  ListCard,
  EventCard,
} from "@/components/app/brain-cards";

type BrainTabContentProps = {
  agentId: string | null;
  repoRoot: string | null;
};

export function BrainTabContent({
  agentId,
  repoRoot,
}: BrainTabContentProps): JSX.Element {
  const { data, isLoading, isError } = useAgentBrainActivity(agentId, repoRoot);

  if (!agentId || !repoRoot) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">No brain context available for this agent.</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center p-4">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">Failed to load brain data.</div>
        </div>
      </div>
    );
  }

  const objects = data?.objects ?? [];
  const lists = data?.lists ?? [];
  const events = data?.events ?? [];

  if (objects.length === 0 && lists.length === 0 && events.length === 0) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8 text-muted-foreground" />
          <div className="mt-4">
            This agent hasn't written any brain data yet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-y-auto")}>
      <div className="px-3 py-3 border-b border-border flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Shared memory this agent has written.
        </p>
        {repoRoot ? (
          <Link
            to={`/automations/brains/${encodeRepoRoot(repoRoot)}`}
            className="flex items-center gap-1 text-[11px] text-primary/70 hover:text-primary transition-colors shrink-0"
          >
            View full brain
            <ArrowRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>
      <CollapsibleSection
        title="Objects"
        icon={Database}
        count={objects.length}
      >
        {objects.map((obj) => (
          <ObjectCard key={`${obj.collection}/${obj.name}`} obj={obj} />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Lists" icon={List} count={lists.length}>
        {lists.map((list) => (
          <ListCard
            key={`${list.collection}/${list.name}`}
            list={list}
            repoRoot={repoRoot!}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Events" icon={Radio} count={events.length}>
        {events.map((event) => (
          <EventCard key={event.id} event={event} />
        ))}
      </CollapsibleSection>
    </div>
  );
}
