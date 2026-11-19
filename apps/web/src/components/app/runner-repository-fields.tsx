import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export type RunnerBranchMode = "new" | "existing";

export function isRepositoryUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

export function RunnerRepositoryFields({
  runnerId,
  canSearch,
  repository,
  onRepository,
  mode,
  onMode,
  branch,
  onBranch,
  loading,
  failed,
}: {
  runnerId: string;
  canSearch: boolean;
  repository: string;
  onRepository: (value: string) => void;
  mode: RunnerBranchMode;
  onMode: (mode: RunnerBranchMode) => void;
  branch: string;
  onBranch: (branch: string) => void;
  loading: boolean;
  failed: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const text = repository.trim();
  const searchable = /^[a-z0-9_.-][a-z0-9_./ -]{1,99}$/i.test(text);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchable ? text : ""), 300);
    return () => clearTimeout(timeout);
  }, [text, searchable]);
  const matches = useQuery({
    queryKey: ["runner-repository-search", runnerId, search],
    queryFn: ({ signal }) =>
      api<{ repositories: { name: string; url: string }[] }>(
        `/api/v1/runners/${encodeURIComponent(runnerId)}/repository-search?q=${encodeURIComponent(search)}`,
        { signal, cache: "no-store" }
      ),
    enabled: canSearch && Boolean(search && search === text && searchable),
    retry: false,
    gcTime: 0,
  });
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={id} className="text-sm">
          Repository <span className="text-muted-foreground">(optional)</span>
        </label>
        <Input
          id={id}
          value={repository}
          onChange={(e) => onRepository(e.target.value)}
          placeholder={
            canSearch
              ? "Search GitHub or paste an HTTPS URL"
              : "Paste an HTTPS repository URL"
          }
          autoComplete="off"
          data-testid="runner-repository"
          disabled={loading}
        />
        {loading ? (
          <p className="text-xs text-muted-foreground">
            Checking the project’s repository…
          </p>
        ) : !text ? (
          <p className="text-xs text-muted-foreground">
            {failed && "Couldn’t read the project’s repository. "}Leave empty
            for a private session folder. Archiving the session deletes that
            folder.
          </p>
        ) : null}
        {canSearch &&
          search &&
          text === search &&
          searchable &&
          (matches.isLoading ? (
            <p className="text-xs text-muted-foreground">Searching GitHub…</p>
          ) : matches.isError ? (
            <p className="text-xs text-muted-foreground">
              Check this runner’s GitHub sign-in or paste a repository URL.
            </p>
          ) : matches.data?.repositories.length ? (
            <ul
              className="max-h-36 overflow-auto rounded-md border p-1"
              aria-label="Matching repositories"
            >
              {matches.data.repositories.map((r) => (
                <li key={r.url}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => onRepository(r.url)}
                  >
                    {r.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No matching repositories. You can paste a URL.
            </p>
          ))}
      </div>
      {isRepositoryUrl(text) && (
        <div className="space-y-2">
          <div className="space-y-1 text-sm">
            <label id={id + "-branch-mode"}>Branch</label>
            <Select
              value={mode}
              onValueChange={(value) => onMode(value as RunnerBranchMode)}
            >
              <SelectTrigger aria-labelledby={id + "-branch-mode"}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">Create a session branch</SelectItem>
                <SelectItem value="existing">
                  Use an existing branch or PR
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="block space-y-1 text-sm">
            <span>
              {mode === "new" ? "Base branch" : "Branch or pull request"}
            </span>
            <Input
              value={branch}
              onChange={(e) => onBranch(e.target.value)}
              placeholder={
                mode === "new"
                  ? "Repository default"
                  : "Branch name or GitHub PR URL"
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Archiving removes the session worktree. Commit and push changes you
            want to keep.
          </p>
        </div>
      )}
    </div>
  );
}
