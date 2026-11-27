import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, GitFork } from "lucide-react";
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
import type { Project } from "@/hooks/use-projects";
import { api } from "@/lib/api";
import { ProjectIcon } from "./project-location";

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
  projects?: Project[];
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
              className="min-w-0 flex-1 justify-between"
              ref={trigger}
              aria-labelledby={labelId}
              role="combobox"
              aria-required="true"
              disabled={pending}
              data-testid="create-agent-runner-project"
            >
              <span className="flex min-w-0 items-center gap-2">
                {project ? (
                  <ProjectIcon project={project} />
                ) : repository ? (
                  <GitFork className="size-4 shrink-0" />
                ) : null}
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
              <CommandList className="min-h-0 touch-pan-y overscroll-contain">
                {projectMatches.length > 0 && (
                  <CommandGroup heading="Projects">
                    {projectMatches.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={`project:${item.id}`}
                        onSelect={() => {
                          onProject?.(item.id);
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
                className="empty:hidden px-3 py-2 text-body-sm text-muted-foreground"
              >
                {urlInput && !validUrl
                  ? "Invalid repository URL."
                  : searchGitHub && (search !== text || matches.isFetching)
                    ? "Searching GitHub…"
                    : searchGitHub && matches.isError
                      ? "Couldn’t search repositories."
                      : !projectMatches.length &&
                          !repositories.length &&
                          !validUrl
                        ? loading
                          ? "Loading projects…"
                          : error
                            ? "Couldn’t load projects."
                            : "No matches."
                        : null}
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
