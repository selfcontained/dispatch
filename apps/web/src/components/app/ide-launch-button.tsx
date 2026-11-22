import { Code2 } from "lucide-react";
import { siCursor } from "simple-icons";
import { useAtom } from "jotai";
import { Link } from "react-router-dom";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { SplitButton } from "@/components/ui/split-button";
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
      className={cn("size-icon-md", className)}
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
  enabledIdes = [],
  runnerCheckout = false,
}: {
  path: string;
  enabledIdes?: IdeType[];
  runnerCheckout?: boolean;
}): JSX.Element {
  const [preferredIde, setPreferredIde] = useAtom(preferredIdeAtom);
  const onLoopback = isLoopbackHost();
  const orderedEnabled = IDE_TYPES.filter((ide) => enabledIdes.includes(ide));

  // Empty-state CTA: when on loopback with no IDEs enabled, show a discoverable
  // button that links into Settings → Workspace so users find the toggle.
  if (!runnerCheckout && onLoopback && orderedEnabled.length === 0) {
    return (
      <IconButton
        asChild
        variant="secondary"
        size="icon-sm"
        label="Configure IDEs in Settings"
        tooltip="Open in IDE — enable an IDE in Settings → Workspace"
        data-testid="ide-launch-cta"
      >
        <Link to="/settings/workspace">
          <Code2 className="size-icon-md" />
        </Link>
      </IconButton>
    );
  }

  // The browser invokes a URL handler on its own desktop.
  if (runnerCheckout || !onLoopback) {
    const reason = runnerCheckout
      ? "Open in IDE is unavailable for runner checkouts"
      : "Open in IDE does not work when accessing Dispatch remotely";
    const fallbackIde =
      orderedEnabled[0] ??
      (IDE_TYPES.includes(preferredIde) ? preferredIde : "vscode");
    return (
      <IconButton
        variant="secondary"
        size="icon-sm"
        disabled
        label={
          runnerCheckout ? reason : "Open in IDE (unavailable on remote access)"
        }
        tooltip={reason}
        data-testid="ide-launch-disabled"
        className="disabled:pointer-events-auto"
      >
        <IdeIcon ide={fallbackIde} />
      </IconButton>
    );
  }

  const activeIde = orderedEnabled.includes(preferredIde)
    ? preferredIde
    : orderedEnabled[0];
  const launchUrl = buildIdeUrl(activeIde, path);
  const choose = (ide: IdeType) => setPreferredIde(ide);
  const showPicker = orderedEnabled.length > 1;

  return (
    <SplitButton
      asChild
      size="xs"
      aria-label={`Open in ${IDE_LABELS[activeIde]}`}
      hint={`Open in ${IDE_LABELS[activeIde]}`}
      data-testid="ide-launch-button"
      menuLabel="Choose IDE"
      menuTestId="ide-launch-dropdown"
      menuProps={{ align: "start" }}
      menu={
        showPicker
          ? orderedEnabled.map((ide) => (
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
                    className="size-icon-md shrink-0 text-muted-foreground"
                  />
                  <span>Open in {IDE_LABELS[ide]}</span>
                </a>
              </DropdownMenuItem>
            ))
          : null
      }
    >
      <a href={launchUrl}>
        <IdeIcon ide={activeIde} />
      </a>
    </SplitButton>
  );
}
