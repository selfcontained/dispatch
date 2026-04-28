import { ChevronDown } from "lucide-react";
import { siCursor } from "simple-icons";
import { useAtom } from "jotai";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type PreferredIde, preferredIdeAtom } from "@/lib/store";
import { cn } from "@/lib/utils";

const VSCODE_LOGO_PATH =
  "M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a1 1 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a1 1 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896Z";

const IDE_META: Record<
  PreferredIde,
  { label: string; scheme: string; viewBox: string; path: string }
> = {
  vscode: {
    label: "VS Code",
    scheme: "vscode",
    viewBox: "0 0 24 24",
    path: VSCODE_LOGO_PATH,
  },
  cursor: {
    label: "Cursor",
    scheme: "cursor",
    viewBox: "0 0 24 24",
    path: siCursor.path,
  },
};

const ALL_IDES: PreferredIde[] = ["vscode", "cursor"];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackHost(): boolean {
  if (typeof window === "undefined") return false;
  return LOOPBACK_HOSTS.has(window.location.hostname);
}

function IdeIcon({
  ide,
  className,
}: {
  ide: PreferredIde;
  className?: string;
}): JSX.Element {
  const meta = IDE_META[ide];
  return (
    <svg
      viewBox={meta.viewBox}
      className={cn("h-3 w-3", className)}
      fill="currentColor"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: `<path d="${meta.path}" />` }}
    />
  );
}

function buildIdeUrl(ide: PreferredIde, path: string): string {
  // VS Code / Cursor URI: scheme://file/{absolute path}. The authority is
  // `file`; the absolute path's leading `/` must survive, so we keep the path
  // as-is after `file` (producing e.g. vscode://file/Users/foo/bar).
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${IDE_META[ide].scheme}://file${encoded}`;
}

export function IdeLaunchButton({
  path,
}: {
  path: string;
}): JSX.Element | null {
  const [preferredIde, setPreferredIde] = useAtom(preferredIdeAtom);
  if (!isLoopbackHost()) return null;
  const activeIde = ALL_IDES.includes(preferredIde) ? preferredIde : "vscode";
  const launchUrl = buildIdeUrl(activeIde, path);
  const choose = (ide: PreferredIde) => setPreferredIde(ide);

  return (
    <div className="inline-flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="sm"
            aria-label={`Open in ${IDE_META[activeIde].label}`}
            data-testid="ide-launch-button"
            className="group relative h-auto rounded-l-full rounded-r-none border border-r-0 border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground before:absolute before:inset-y-[-12px] before:left-[-8px] before:right-0 before:content-[''] hover:bg-muted/60 hover:text-foreground"
          >
            <a href={launchUrl}>
              <IdeIcon ide={activeIde} className="h-3 w-3" />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in {IDE_META[activeIde].label}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Choose IDE"
            data-testid="ide-launch-dropdown"
            className="relative h-auto rounded-l-none rounded-r-full border border-border bg-muted/35 px-1 py-0.5 text-muted-foreground before:absolute before:inset-y-[-12px] before:left-0 before:right-[-8px] before:content-[''] hover:bg-muted/60 hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {ALL_IDES.map((ide) => (
            <DropdownMenuItem
              key={ide}
              asChild
              className="text-foreground"
              data-testid={`ide-launch-option-${ide}`}
            >
              <a
                href={buildIdeUrl(ide, path)}
                onClick={() => choose(ide)}
                className="flex items-center gap-2 whitespace-nowrap"
              >
                <IdeIcon ide={ide} className="h-3.5 w-3.5 shrink-0" />
                <span>Open in {IDE_META[ide].label}</span>
              </a>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
