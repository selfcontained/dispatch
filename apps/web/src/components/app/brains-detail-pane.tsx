import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { Brain, Search, Trash2 } from "lucide-react";

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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageContent, PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/async-boundary";
import { toast } from "@/components/ui/toast";
import { ChipButton } from "@/components/ui/chip";
import { CountBubble } from "@/components/ui/count-bubble";

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
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <PageHeader title="Brains" />
      <PageContent mode="full">
        <EmptyState
          icon={Brain}
          title="Brain Explorer"
          description="Select a project to inspect its shared brain memory — objects, lists, and events organized by collection."
        />
      </PageContent>
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
  const collectionsQuery = useBrainCollections(repoRoot);
  const { data: collections = [], isLoading: collectionsLoading } =
    collectionsQuery;
  const [search, setSearch] = useState("");
  const [projectDeleteOpen, setProjectDeleteOpen] = useState(false);
  const { deleteProject } = useBrainActions();

  const confirmProjectDelete = async () => {
    const result = await deleteProject.mutateAsync({ repoRoot });
    toast.success(
      `Deleted ${result.objects + result.lists + result.events} entries from this project.`
    );
    setProjectDeleteOpen(false);
    navigate("/automations/brains", { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <PageHeader
        title={repoBasename(repoRoot)}
        description={
          <span className="font-mono" title={repoRoot}>
            {repoRoot}
          </span>
        }
        actions={
          <Button
            type="button"
            variant="ghost"
            tone="danger"
            size="sm"
            onClick={() => setProjectDeleteOpen(true)}
          >
            <Trash2 />
            Clear project
          </Button>
        }
      />

      <PageContent mode="full">
        <div className="shrink-0 border-b border-border-subtle px-4 md:px-6">
          <div className="flex items-center gap-3 py-2">
            <span className="hidden shrink-0 text-label-sm font-medium text-muted-foreground md:block">
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
                <SelectTrigger className="h-8 text-body-sm">
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
                onClick={() =>
                  navigate(`/automations/brains/${encodedRepoRoot}`)
                }
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
              <Search className="pointer-events-none absolute z-sticky left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter…"
                className="h-8 w-32 pl-8 text-body-sm md:w-40"
              />
            </div>
          </div>
        </div>

        {collectionsQuery.error ? (
          <LoadError
            thing="collections"
            error={collectionsQuery.error}
            retrying={collectionsQuery.isFetching}
            onRetry={() => void collectionsQuery.refetch()}
            className="m-3 mb-0"
          />
        ) : null}
        <BrainCollectionView
          repoRoot={repoRoot}
          collection={selectedCollection}
          search={search}
          onCollectionCleared={() =>
            navigate(`/automations/brains/${encodedRepoRoot}`, {
              replace: true,
            })
          }
        />
      </PageContent>
      <ConfirmDialog
        open={projectDeleteOpen}
        onOpenChange={setProjectDeleteOpen}
        title={`Clear “${repoBasename(repoRoot)}”?`}
        description="This permanently deletes every object, list, and event in all collections for this project."
        confirmLabel="Clear project"
        errorTitle="Couldn’t clear the project."
        onConfirm={confirmProjectDelete}
      />
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
    <ChipButton selected={active} aria-pressed={active} onClick={onClick}>
      {label}
      {count !== undefined ? <CountBubble count={String(count)} /> : null}
    </ChipButton>
  );
}
