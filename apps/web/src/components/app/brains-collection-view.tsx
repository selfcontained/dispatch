import { useState } from "react";
import { Brain, Database, List, Radio, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  useBrainObjects,
  useBrainLists,
  useBrainEvents,
  useBrainActions,
  type BrainObject,
  type BrainList,
  type BrainEvent,
} from "@/hooks/use-brain";
import {
  CollapsibleSection,
  ObjectCard,
  ListCard,
  EventCard,
} from "@/components/app/brain-cards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DeleteTarget =
  | { type: "object"; object: BrainObject }
  | { type: "list"; list: BrainList }
  | { type: "event"; event: BrainEvent }
  | { type: "collection"; collection: string };

export function BrainCollectionView({
  repoRoot,
  collection,
  search,
  onCollectionCleared,
}: {
  repoRoot: string;
  collection: string | null;
  search: string;
  onCollectionCleared: () => void;
}): JSX.Element {
  const objectFilters = collection ? { collection } : { limit: 100 };
  const listFilters = collection ? { collection } : { limit: 100 };
  const eventFilters = collection ? { collection, limit: 100 } : { limit: 100 };

  const { data: objects = [], isLoading: objectsLoading } = useBrainObjects(
    repoRoot,
    objectFilters
  );
  const { data: lists = [], isLoading: listsLoading } = useBrainLists(
    repoRoot,
    listFilters
  );
  const { data: events = [], isLoading: eventsLoading } = useBrainEvents(
    repoRoot,
    eventFilters
  );
  const { deleteObject, deleteList, deleteEvent, deleteCollection } =
    useBrainActions();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const isLoading = objectsLoading || listsLoading || eventsLoading;

  const lowerSearch = search.toLowerCase();
  const filteredObjects = search
    ? objects.filter(
        (o) =>
          o.name.toLowerCase().includes(lowerSearch) ||
          o.collection.toLowerCase().includes(lowerSearch)
      )
    : objects;
  const filteredLists = search
    ? lists.filter(
        (l) =>
          l.name.toLowerCase().includes(lowerSearch) ||
          l.collection.toLowerCase().includes(lowerSearch)
      )
    : lists;
  const filteredEvents = search
    ? events.filter(
        (e) =>
          e.kind.toLowerCase().includes(lowerSearch) ||
          (e.subject?.toLowerCase().includes(lowerSearch) ?? false) ||
          e.collection.toLowerCase().includes(lowerSearch)
      )
    : events;

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      </div>
    );
  }

  if (
    filteredObjects.length === 0 &&
    filteredLists.length === 0 &&
    filteredEvents.length === 0
  ) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <Brain className="h-8 w-8" />
          <div className="mt-4">
            {search
              ? "No brain data matches your filter."
              : "No brain data in this collection yet."}
          </div>
        </div>
      </div>
    );
  }

  const isCapped =
    !collection &&
    (objects.length >= 100 || lists.length >= 100 || events.length >= 100);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === "object") {
        await deleteObject.mutateAsync({
          repoRoot,
          collection: deleteTarget.object.collection,
          name: deleteTarget.object.name,
        });
        toast.success("Object deleted.");
      } else if (deleteTarget.type === "list") {
        await deleteList.mutateAsync({
          repoRoot,
          collection: deleteTarget.list.collection,
          name: deleteTarget.list.name,
        });
        toast.success("List deleted.");
      } else if (deleteTarget.type === "event") {
        await deleteEvent.mutateAsync({ repoRoot, id: deleteTarget.event.id });
        toast.success("Event deleted.");
      } else {
        const result = await deleteCollection.mutateAsync({
          repoRoot,
          collection: deleteTarget.collection,
        });
        toast.success(
          `Deleted ${result.objects + result.lists + result.events} entries from ${deleteTarget.collection}.`
        );
        onCollectionCleared();
      }
      setDeleteTarget(null);
    } catch {
      toast.error("Could not delete brain data.");
    }
  };

  const deleting =
    deleteObject.isPending ||
    deleteList.isPending ||
    deleteEvent.isPending ||
    deleteCollection.isPending;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div className="space-y-1 px-1 pt-4 pb-12 sm:px-2 md:px-5">
        {isCapped && !search ? (
          <div className="mx-3 mb-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Showing the first 100 items per section. Select a collection to see
            all entries.
          </div>
        ) : null}

        {collection ? (
          <div className="mx-3 mb-2 flex justify-end">
            <Button
              type="button"
              variant="ghost-destructive"
              size="sm"
              onClick={() =>
                setDeleteTarget({ type: "collection", collection })
              }
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Clear collection
            </Button>
          </div>
        ) : null}

        <CollapsibleSection
          title="Objects"
          icon={Database}
          count={filteredObjects.length}
        >
          {filteredObjects.map((obj) => (
            <ObjectCard
              key={`${obj.collection}/${obj.name}`}
              obj={obj}
              agentId={obj.updatedByAgentId}
              revision={obj.revision}
              onDelete={() => setDeleteTarget({ type: "object", object: obj })}
            />
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Lists"
          icon={List}
          count={filteredLists.length}
        >
          {filteredLists.map((list) => (
            <ListCard
              key={`${list.collection}/${list.name}`}
              list={list}
              repoRoot={repoRoot}
              agentId={list.updatedByAgentId}
              onDelete={() => setDeleteTarget({ type: "list", list })}
            />
          ))}
        </CollapsibleSection>

        <CollapsibleSection
          title="Events"
          icon={Radio}
          count={filteredEvents.length}
        >
          {filteredEvents.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              agentId={event.agentId}
              onDelete={() => setDeleteTarget({ type: "event", event })}
            />
          ))}
        </CollapsibleSection>
      </div>
      <DeleteBrainDialog
        target={deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        deleting={deleting}
      />
    </div>
  );
}

function DeleteBrainDialog({
  target,
  onOpenChange,
  onConfirm,
  deleting,
}: {
  target: DeleteTarget | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  deleting: boolean;
}): JSX.Element {
  const title =
    target?.type === "object"
      ? `Delete ${target.object.name}?`
      : target?.type === "list"
        ? `Delete ${target.list.name}?`
        : target?.type === "event"
          ? `Delete ${target.event.kind} event?`
          : `Clear ${target?.collection ?? "collection"}?`;
  const description =
    target?.type === "collection"
      ? `This permanently deletes all objects, lists, and events in “${target.collection}” for this project.`
      : "This permanently deletes shared brain data for this project.";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete permanently"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
