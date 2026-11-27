import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, GitFork, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Spinner } from "@/components/ui/spinner";
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
import type { Project } from "@/hooks/use-projects";
import { api } from "@/lib/api";
import { ProjectIcon } from "./project-location";

type PickerProject = Project & { repository?: string | null };

/** Display only; the server remains responsible for repository identity. */
function repositoryLabel(value: string) {
  try {
    const url = new URL(value);
    return url.pathname
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(/^\//, "");
  } catch {
    return value;
  }
}

function RepositoryName({ value }: { value: string }) {
  const label = repositoryLabel(value);
  const split = label.lastIndexOf("/");
  return (
    <span className="flex min-w-0 flex-1 items-baseline" title={label}>
      {split >= 0 && (
        <span className="flex max-w-[40%] min-w-0 shrink text-muted-foreground">
          <span className="truncate">{label.slice(0, split)}</span>
          <span className="shrink-0">/</span>
        </span>
      )}
      <span className="min-w-0 truncate font-medium">
        {label.slice(split + 1)}
      </span>
    </span>
  );
}

function ProjectAvatar({ project }: { project: PickerProject }) {
  return (
    <ProjectIcon
      project={project}
      className="size-5"
      fallback={
        <span style={{ color: project.color }}>
          {project.name.slice(0, 1).toUpperCase()}
        </span>
      }
    />
  );
}

const groupClassName =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-label-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground [&+[cmdk-group]]:border-t [&+[cmdk-group]]:border-border";
const rowClassName = "py-1.5 text-body-md data-[selected=true]:bg-fill-hover";

export function RunnerRepositoryPicker({
  searchUrl,
  projectId,
  repository = "",
  projects = [],
  loading = false,
  error = false,
  pending = false,
  onProject,
  onRepository,
}: {
  searchUrl?: string;
  projectId?: string | null;
  projects?: PickerProject[];
  loading?: boolean;
  error?: boolean;
  pending?: boolean;
  repository?: string;
  onProject?: (id: string) => void;
  onRepository: (url: string) => void;
}) {
  const labelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const project = projects.find((item) => item.id === projectId);
  const text = input.trim();
  const urlInput = /^(?:\w+:\/\/|git@)/i.test(text);
  let validUrl = false;
  try {
    const url = new URL(text);
    validUrl =
      url.protocol === "https:" &&
      Boolean(url.hostname && url.pathname !== "/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {}
  const canSearch = Boolean(searchUrl);
  const searchGitHub = open && canSearch && !urlInput && text.length >= 2;
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchGitHub ? text : ""), 300);
    return () => clearTimeout(timeout);
  }, [text, searchGitHub]);
  const matches = useQuery({
    queryKey: ["runner-repository-search", searchUrl, search],
    queryFn: ({ signal }) =>
      api<{ repositories: { name: string; url: string }[] }>(
        `${searchUrl}?q=${encodeURIComponent(search)}`,
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
  const searching = searchGitHub && (search !== text || matches.isFetching);
  const status =
    urlInput && !validUrl
      ? "Invalid repository URL."
      : searching
        ? "Searching GitHub…"
        : searchGitHub && matches.isError
          ? "Couldn’t search repositories."
          : !projectMatches.length && !repositories.length && !validUrl
            ? loading
              ? "Loading projects…"
              : error
                ? "Couldn’t load projects."
                : "No matches."
            : null;
  // A quiet annotation from already loaded data, never an admission decision.
  const linkedProject = (url: string) =>
    projects.find((item) => {
      if (!item.repository) return false;
      try {
        return (
          new URL(item.repository).host === new URL(url).host &&
          repositoryLabel(item.repository) === repositoryLabel(url)
        );
      } catch {
        return false;
      }
    });
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setInput("");
  };
  // Keep the results inside the dialog's scroll lock and clipping boundary.
  const dialog = trigger.current?.closest<HTMLElement>('[role="dialog"]');

  return (
    <div className="space-y-1">
      <label id={labelId} className="text-body-md text-muted-foreground">
        {onProject ? "Project" : "Repository"}
      </label>
      <div className="flex gap-1">
        <Popover open={open} onOpenChange={changeOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="md"
              className="min-w-0 flex-1 justify-between"
              ref={trigger}
              aria-labelledby={labelId}
              role="combobox"
              aria-required="true"
              disabled={pending}
              data-testid="create-agent-runner-project"
            >
              <span className="flex min-w-0 items-center gap-2">
                {(project || repository) && (
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {project ? (
                      <ProjectAvatar project={project} />
                    ) : repository ? (
                      <GitFork className="size-4 shrink-0" />
                    ) : null}
                  </span>
                )}
                <span className="truncate" id={`${labelId}-value`}>
                  {project?.name ??
                    (pending
                      ? "Creating project…"
                      : repository ||
                        (onProject
                          ? "Choose a project or repository"
                          : "Choose a repository"))}
                </span>
              </span>
              <ChevronDown className="size-4 shrink-0" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            container={dialog}
            collisionBoundary={dialog}
            align="start"
            aria-label="Choose a project or repository"
            className="flex w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
          >
            <Command
              shouldFilter={false}
              className="min-h-0 border-0 bg-transparent shadow-none"
            >
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <CommandInput
                  className="pl-7 pr-6"
                  aria-label="Search projects or repositories"
                  placeholder={
                    canSearch
                      ? "Search projects or your repos, or paste a URL"
                      : "Search projects or paste an HTTPS URL"
                  }
                  value={input}
                  onValueChange={setInput}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center">
                  {(searching || loading) && (
                    <Spinner className="size-3.5 text-muted-foreground" />
                  )}
                </span>
              </div>
              <CommandList className="h-80 max-h-[calc(var(--radix-popover-content-available-height)_-_2.5rem)] min-h-0 shrink-0 touch-pan-y overscroll-contain">
                {projectMatches.length > 0 && (
                  <CommandGroup className={groupClassName} heading="Projects">
                    {projectMatches.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={`project:${item.id}`}
                        aria-label={item.name}
                        className={rowClassName}
                        onSelect={() => {
                          onProject?.(item.id);
                          changeOpen(false);
                        }}
                      >
                        <ProjectAvatar project={item} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-normal">
                            {item.name}
                          </span>
                          {item.repository && (
                            <span className="block truncate text-body-sm text-muted-foreground">
                              {repositoryLabel(item.repository)}
                            </span>
                          )}
                        </span>
                        {item.id === projectId && (
                          <Check
                            aria-label="Selected"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {searchGitHub && (
                  <CommandGroup
                    className={groupClassName}
                    heading="Your GitHub repositories"
                  >
                    {repositories.map((item) => {
                      const linked = linkedProject(item.url);
                      return (
                        <CommandItem
                          key={item.url}
                          value={item.url}
                          aria-label={item.name}
                          className={rowClassName}
                          onSelect={() => {
                            onRepository(item.url);
                            changeOpen(false);
                          }}
                        >
                          <GitFork
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <RepositoryName value={item.name} />
                          {linked && (
                            <span title={linked.name} aria-label={linked.name}>
                              <ProjectAvatar project={linked} />
                            </span>
                          )}
                          {(repository === item.url ||
                            Boolean(projectId && linked?.id === projectId)) && (
                            <Check
                              aria-label="Selected"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}
                {validUrl && (
                  <CommandGroup
                    className={groupClassName}
                    heading="Repository URL"
                  >
                    <CommandItem
                      value={text}
                      aria-label={repositoryLabel(text)}
                      className={rowClassName}
                      onSelect={() => {
                        onRepository(text);
                        changeOpen(false);
                      }}
                    >
                      <GitFork
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <RepositoryName value={text} />
                      {repository === text && (
                        <Check
                          aria-label="Selected"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                    </CommandItem>
                  </CommandGroup>
                )}
                <div
                  role="status"
                  aria-live="polite"
                  className={
                    status && !searching && !loading
                      ? "flex h-9 shrink-0 items-center px-3 text-body-sm text-muted-foreground"
                      : "sr-only"
                  }
                >
                  {status}
                </div>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
