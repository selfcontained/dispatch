import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Brain, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useBrainCollections, useBrainActions } from "@/hooks/use-brain";
import { BrainCollectionView } from "@/components/app/brains-collection-view";
import { repoBasename } from "@/components/app/brains-utils";
import { decodeRepoRoot } from "@/lib/brain-encoding";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function BrainsDetailPane(): JSX.Element {
  const { encodedRepoRoot, collection } = useParams<{
    encodedRepoRoot?: string;
    collection?: string;
  }>();

  if (!encodedRepoRoot) {
    return <BrainsOverview />;
  }

  let repoRoot: string;
  try {
    repoRoot = decodeRepoRoot(encodedRepoRoot);
  } catch {
    // Has to be declarative: react-router refuses an imperative navigate()
    // during render, so calling it here would only warn and leave the
    // undecodable repo root sitting in the address bar.
    return <Navigate to="/automations/brains" replace />;
  }

  return (
    <BrainProjectDetail
      repoRoot={repoRoot}
      encodedRepoRoot={encodedRepoRoot}
      // react-router has already decoded the path param. Decoding it a second
      // time silently mangles a collection whose name contains an escape-like
      // sequence, and throws outright on a bare "%".
      selectedCollection={collection ?? null}
    />
  );
}

function BrainsOverview(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
      <div>
        <Brain className="mx-auto mb-3 h-8 w-8" />
        <div className="font-medium text-foreground">Brain Explorer</div>
        <div className="mt-1 max-w-sm text-sm">
          Select a project to inspect its shared brain memory — objects, lists,
          and events organized by collection.
        </div>
      </div>
    </div>
  );
}

function BrainProjectDetail({
  repoRoot,
  encodedRepoRoot,
  selectedCollection,
}: {
  repoRoot: string;
  encodedRepoRoot: string;
  selectedCollection: string | null;
}): JSX.Element {
  const navigate = useNavigate();
  const { data: collections = [], isLoading: collectionsLoading } =
    useBrainCollections(repoRoot);
  const [search, setSearch] = useState("");
  const [projectDeleteOpen, setProjectDeleteOpen] = useState(false);
  const { deleteProject } = useBrainActions();

  const confirmProjectDelete = async () => {
    try {
      const result = await deleteProject.mutateAsync({ repoRoot });
      toast.success(
        `Deleted ${result.objects + result.lists + result.events} entries from this project.`
      );
      setProjectDeleteOpen(false);
      navigate("/automations/brains", { replace: true });
    } catch {
      toast.error("Could not delete project brain data.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3 md:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">
              {repoBasename(repoRoot)}
            </h2>
            <div
              className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
              title={repoRoot}
            >
              {repoRoot}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost-destructive"
            size="sm"
            onClick={() => setProjectDeleteOpen(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Clear project
          </Button>
        </div>
      </div>

      <div className="border-b border-border px-4 md:px-6">
        <div className="flex items-center gap-3 py-2">
          <span className="hidden shrink-0 text-[11px] font-medium text-muted-foreground md:block">
            Collections
          </span>

          {/* Mobile: dropdown */}
          <div className="min-w-0 flex-1 md:hidden">
            <Select
              value={selectedCollection ?? "__all__"}
              onValueChange={(val) => {
                if (val === "__all__") {
                  navigate(`/automations/brains/${encodedRepoRoot}`);
                } else {
                  navigate(
                    `/automations/brains/${encodedRepoRoot}/${encodeURIComponent(val)}`
                  );
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All collections" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All collections</SelectItem>
                {collectionsLoading
                  ? null
                  : collections.map((col) => (
                      <SelectItem key={col.collection} value={col.collection}>
                        {col.collection} (
                        {col.objectCount + col.listCount + col.eventCount})
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>

          {/* Desktop: pills */}
          <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none md:flex">
            <CollectionPill
              label="All"
              active={selectedCollection === null}
              onClick={() => navigate(`/automations/brains/${encodedRepoRoot}`)}
            />
            {collectionsLoading
              ? null
              : collections.map((col) => (
                  <CollectionPill
                    key={col.collection}
                    label={col.collection}
                    count={col.objectCount + col.listCount + col.eventCount}
                    active={selectedCollection === col.collection}
                    onClick={() =>
                      navigate(
                        `/automations/brains/${encodedRepoRoot}/${encodeURIComponent(col.collection)}`
                      )
                    }
                  />
                ))}
          </div>

          <div className="relative shrink-0">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="h-8 w-32 pl-8 text-xs md:w-40"
            />
          </div>
        </div>
      </div>

      <BrainCollectionView
        repoRoot={repoRoot}
        collection={selectedCollection}
        search={search}
        onCollectionCleared={() =>
          navigate(`/automations/brains/${encodedRepoRoot}`, { replace: true })
        }
      />
      <Dialog open={projectDeleteOpen} onOpenChange={setProjectDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear this project?</DialogTitle>
            <DialogDescription>
              This permanently deletes every object, list, and event in all
              collections for this project.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setProjectDeleteOpen(false)}
              disabled={deleteProject.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmProjectDelete()}
              disabled={deleteProject.isPending}
            >
              {deleteProject.isPending ? "Deleting..." : "Delete permanently"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CollectionPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      )}
    >
      {label}
      {count !== undefined ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px]",
            active ? "bg-primary/20" : "bg-muted"
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
