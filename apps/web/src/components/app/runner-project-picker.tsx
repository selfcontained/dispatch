import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, GitFork, X } from "lucide-react";
import { validRepositorySearch } from "@dispatch/runner-protocol";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useProjects } from "@/hooks/use-projects";
import { api } from "@/lib/api";
import { ProjectIcon } from "./project-location";
import { parseRunnerRepositoryUrl } from "@dispatch/runner-protocol";

export function RunnerProjectPicker({
  runnerId,
  canSearch,
  updateNeeded,
  projectId,
  repository,
  onProject,
  onRepository,
}: {
  runnerId: string;
  canSearch: boolean;
  updateNeeded: boolean;
  projectId: string | null;
  repository: string;
  onProject: (id: string | null) => void;
  onRepository: (url: string) => void;
}) {
  const labelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const { data: projects = [], isLoading, isError } = useProjects();
  const project = projects.find((item) => item.id === projectId);
  const text = input.trim();
  const urlInput = /^(?:\w+:\/\/|git@)/i.test(text);
  const validUrl = Boolean(parseRunnerRepositoryUrl(text));
  const searchGitHub =
    open && canSearch && !urlInput && validRepositorySearch(text);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchGitHub ? text : ""), 300);
    return () => clearTimeout(timeout);
  }, [text, searchGitHub]);
  const matches = useQuery({
    queryKey: ["runner-repository-search", runnerId, search],
    queryFn: ({ signal }) =>
      api<{ repositories: { name: string; url: string }[] }>(
        `/api/v1/runners/${encodeURIComponent(runnerId)}/repository-search?q=${encodeURIComponent(search)}`,
        { signal, cache: "no-store" }
      ),
    enabled: searchGitHub && search === text,
    retry: false,
    gcTime: 0,
  });
  const projectMatches = projects.filter((item) =>
    item.name.toLowerCase().includes(text.toLowerCase())
  );
  const repositories =
    searchGitHub && search === text && !matches.isError
      ? (matches.data?.repositories ?? [])
      : [];
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setInput("");
  };
  const hasSelection = Boolean(projectId || repository);

  return (
    <div className="space-y-1">
      <label id={labelId} className="text-sm text-muted-foreground">
        Project or repository <span className="opacity-70">(optional)</span>
      </label>
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="default"
              className="h-[38px] min-w-0 flex-1 justify-between px-3"
              ref={trigger}
              aria-labelledby={`${labelId} ${labelId}-value`}
              data-testid="runner-repository"
            >
              <span className="flex min-w-0 items-center gap-2">
                {project ? (
                  <ProjectIcon project={project} />
                ) : repository ? (
                  <GitFork className="size-4 shrink-0" />
                ) : null}
                <span className="truncate" id={`${labelId}-value`}>
                  {project?.name ??
                    (projectId
                      ? "Project"
                      : repository || "Choose a project or repository…")}
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="Choose a project or repository"
            className="w-[var(--radix-popover-trigger-width)] p-0"
          >
            <Command
              shouldFilter={false}
              className="border-0 bg-transparent shadow-none"
            >
              <CommandInput
                aria-label="Search projects or repositories"
                placeholder={
                  canSearch
                    ? "Search projects or your repos, or paste a URL"
                    : "Search projects or paste an HTTPS URL"
                }
                value={input}
                onValueChange={setInput}
              />
              {updateNeeded && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  Update this runner to search your GitHub repositories.
                </p>
              )}
              <CommandList>
                {projectMatches.length > 0 && (
                  <CommandGroup heading="Projects">
                    {projectMatches.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={`project:${item.id}`}
                        onSelect={() => {
                          onProject(item.id);
                          changeOpen(false);
                        }}
                      >
                        <ProjectIcon project={item} />
                        <span className="truncate">{item.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {repositories.length > 0 && (
                  <CommandGroup heading="Your GitHub repositories">
                    {repositories.map((item) => (
                      <CommandItem
                        key={item.url}
                        value={item.url}
                        onSelect={() => {
                          onRepository(item.url);
                          changeOpen(false);
                        }}
                      >
                        <GitFork className="size-4 shrink-0" />
                        <span className="truncate">{item.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {validUrl && (
                  <CommandGroup heading="Repository URL">
                    <CommandItem
                      value={text}
                      onSelect={() => {
                        onRepository(text);
                        changeOpen(false);
                      }}
                    >
                      <GitFork className="size-4 shrink-0" />
                      <span className="truncate">{text}</span>
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
              <div
                role="status"
                className="empty:hidden px-3 py-2 text-xs text-muted-foreground"
              >
                {urlInput && !validUrl
                  ? "Enter an HTTPS Git URL without credentials, a query, or a fragment."
                  : searchGitHub && (search !== text || matches.isFetching)
                    ? "Searching GitHub…"
                    : searchGitHub && matches.isError
                      ? "GitHub search failed on this runner. You can paste a repository URL."
                      : !projectMatches.length &&
                          !repositories.length &&
                          !validUrl
                        ? isLoading
                          ? "Loading projects…"
                          : isError
                            ? "Couldn’t load projects."
                            : "No matches. You can paste a repository URL."
                        : null}
              </div>
            </Command>
          </PopoverContent>
        </Popover>
        {hasSelection && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear project or repository"
            onClick={() => {
              onProject(null);
              trigger.current?.focus();
            }}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      {projectId && repository && (
        <p
          className="truncate text-xs text-muted-foreground"
          title={repository}
        >
          {repository}
        </p>
      )}
      {!hasSelection && (
        <p className="text-xs text-muted-foreground">
          Leave empty to start in a fresh session directory. Archiving removes
          it.
        </p>
      )}
    </div>
  );
}
