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
import { preferredIdeAtom } from "@/lib/store";
import { type IdeType, IDE_LABELS, IDE_TYPES } from "@/lib/ide-types";
import { cn } from "@/lib/utils";

const VSCODE_LOGO_PATH =
  "M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a1 1 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a1 1 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896Z";

const IDE_META: Record<
  IdeType,
  { scheme: string; viewBox: string; path: string }
> = {
  vscode: { scheme: "vscode", viewBox: "0 0 24 24", path: VSCODE_LOGO_PATH },
  cursor: { scheme: "cursor", viewBox: "0 0 24 24", path: siCursor.path },
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackHost(): boolean {
  if (typeof window === "undefined") return false;
  return LOOPBACK_HOSTS.has(window.location.hostname);
}

function IdeIcon({
  ide,
  className,
}: {
  ide: IdeType;
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

function buildIdeUrl(ide: IdeType, path: string): string {
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
  enabledIdes,
}: {
  path: string;
  enabledIdes: IdeType[];
}): JSX.Element | null {
  const [preferredIde, setPreferredIde] = useAtom(preferredIdeAtom);
  if (!isLoopbackHost()) return null;
  // Render in the canonical IDE_TYPES order so the dropdown is stable
  // regardless of the order the user toggled them.
  const orderedEnabled = IDE_TYPES.filter((ide) => enabledIdes.includes(ide));
  if (orderedEnabled.length === 0) return null;
  const activeIde = orderedEnabled.includes(preferredIde)
    ? preferredIde
    : orderedEnabled[0];
  const launchUrl = buildIdeUrl(activeIde, path);
  const choose = (ide: IdeType) => setPreferredIde(ide);
  const showPicker = orderedEnabled.length > 1;

  return (
    <div className="inline-flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            asChild
            variant="ghost"
            size="sm"
            aria-label={`Open in ${IDE_LABELS[activeIde]}`}
            data-testid="ide-launch-button"
            className={cn(
              "group relative h-auto min-h-6 border border-border bg-muted/35 px-2 py-0.5 text-muted-foreground before:absolute before:inset-y-[-12px] before:left-[-8px] before:content-[''] hover:bg-muted/60 hover:text-foreground",
              showPicker
                ? "rounded-l-full rounded-r-none border-r-0 before:right-0"
                : "rounded-full before:right-[-8px]"
            )}
          >
            <a href={launchUrl}>
              <IdeIcon ide={activeIde} className="h-3 w-3" />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in {IDE_LABELS[activeIde]}</TooltipContent>
      </Tooltip>
      {showPicker ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Choose IDE"
              data-testid="ide-launch-dropdown"
              className="relative h-auto min-h-6 rounded-l-none rounded-r-full border border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground before:absolute before:inset-y-[-12px] before:left-0 before:right-[-8px] before:content-[''] hover:bg-muted/60 hover:text-foreground"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {orderedEnabled.map((ide) => (
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
                  <IdeIcon
                    ide={ide}
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                  <span>Open in {IDE_LABELS[ide]}</span>
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
