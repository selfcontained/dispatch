import { Code2 } from "lucide-react";
import { siCursor } from "simple-icons";
import { useAtom } from "jotai";

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

export type IdeLaunchOption = {
  key: string;
  label: string;
  icon: JSX.Element;
  /** The IDE's URL handler. */
  href?: string;
  /** An in-app route, for setting an IDE up. */
  to?: string;
  /** Why it can't run here. */
  reason?: string;
  disabled?: boolean;
  /** Remembers the choice so the preferred IDE comes first next time. */
  onSelect?: () => void;
};

/**
 * Open-in-IDE choices for a menu: one per enabled IDE, preferred first. With
 * none enabled it points at Settings; away from this Mac it is disabled, since
 * the URL handler would open a path that only exists on the host.
 */
export function useIdeLaunchOptions(
  path: string,
  enabledIdes: IdeType[] = []
): IdeLaunchOption[] {
  const [preferredIde, setPreferredIde] = useAtom(preferredIdeAtom);
  const orderedEnabled = IDE_TYPES.filter((ide) => enabledIdes.includes(ide));
  const fallback = <Code2 className="size-icon-md" />;
  if (!isLoopbackHost()) {
    return [
      {
        key: "ide",
        label: "Open in IDE",
        icon: fallback,
        reason: "This Mac only",
        disabled: true,
      },
    ];
  }
  if (orderedEnabled.length === 0) {
    return [
      {
        key: "ide",
        label: "Open in IDE",
        icon: fallback,
        reason: "Set up in Settings",
        to: "/settings/workspace",
      },
    ];
  }
  const ordered = orderedEnabled.includes(preferredIde)
    ? [preferredIde, ...orderedEnabled.filter((ide) => ide !== preferredIde)]
    : orderedEnabled;
  return ordered.map((ide) => ({
    key: `ide-${ide}`,
    label: `Open in ${IDE_LABELS[ide]}`,
    icon: <IdeIcon ide={ide} />,
    href: buildIdeUrl(ide, path),
    onSelect: () => setPreferredIde(ide),
  }));
}
