import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Bell, ChevronDown, ChevronRight, ArrowLeft, ArrowDownToLine, ExternalLink, Palette, RefreshCw, Shield, Trash2, X } from "lucide-react";

import { NotificationSettings } from "@/components/app/notification-settings";
import { ReleaseManager } from "@/components/app/release-manager";
import { SecuritySettings } from "@/components/app/security-settings";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { type ThemeId, THEMES } from "@/hooks/use-theme";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type SettingsSection = "release" | "security" | "notifications" | "appearance" | "app";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof ArrowDownToLine }> = [
  { id: "release", label: "Updates", icon: ArrowDownToLine },
  { id: "security", label: "Security", icon: Shield },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "app", label: "App", icon: RefreshCw }
];

type AppVersionInfo = {
  releaseTag: string | null;
  version: string | null;
  gitSha: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
};

function AppSettings(): JSX.Element {
  const [reloading, setReloading] = useState(false);
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [versionError, setVersionError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void api<AppVersionInfo>("/api/v1/app/version")
      .then((payload) => {
        if (cancelled) return;
        setVersionInfo(payload);
        setVersionError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setVersionError(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleReload = useCallback(() => {
    setReloading(true);
    window.location.reload();
  }, []);

  const handleClearCacheAndReload = useCallback(async () => {
    setReloading(true);
    try {
      // Unregister all service workers and clear their caches
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      window.location.reload();
    } catch {
      // If anything fails, just reload anyway
      window.location.reload();
    }
  }, []);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div data-testid="app-version-card">
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Current version
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Version information for the running app process.
        </p>
        <div className="grid gap-2 rounded border border-border p-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Release tag</span>
            <span className="font-mono" data-testid="app-version-release-tag">
              {versionInfo?.releaseTag ?? "unreleased"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Package version</span>
            <span className="font-mono" data-testid="app-version-semver">
              {versionInfo?.version ?? "unknown"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Git SHA</span>
            <span className="font-mono" data-testid="app-version-git-sha">
              {versionInfo?.gitSha ?? "unavailable"}
            </span>
          </div>
        </div>
        <div className="mt-4 rounded border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Release notes
            </div>
            {versionInfo?.releaseUrl ? (
              <a
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
                href={versionInfo.releaseUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-3 w-3" />
                View on GitHub
              </a>
            ) : null}
          </div>
          <div
            className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground"
            data-testid="app-version-release-notes"
          >
            {versionInfo?.releaseNotes ?? "No release notes are stored for this build yet."}
          </div>
        </div>
        {versionError ? (
          <p className="mt-2 text-xs text-red-300">
            Unable to load version metadata.
          </p>
        ) : null}
      </div>

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Reload
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Reload the app to pick up the latest version. Use the dropdown to clear cached data first if the app feels stuck.
        </p>
        <div className="inline-flex items-stretch">
          <button
            onClick={handleReload}
            disabled={reloading}
            className="inline-flex items-center gap-2 rounded-l border border-r-0 border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", reloading && "animate-spin")} />
            {reloading ? "Reloading…" : "Reload"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={reloading}
                className="inline-flex items-center rounded-r border border-border px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => void handleClearCacheAndReload()}
                className="flex items-center whitespace-nowrap text-muted-foreground"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Clear cache & reload
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function AppearanceSettings({ theme, setTheme }: { theme: ThemeId; setTheme: (id: ThemeId) => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Theme
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Choose a color theme for the interface.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                "flex items-start gap-3 rounded-md border p-3 text-left transition-colors",
                theme === t.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-muted-foreground/30"
              )}
            >
              <div className="mt-0.5 flex gap-1">
                {t.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="block h-4 w-4 rounded-full border border-white/10"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type SettingsPaneProps = {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
  theme: ThemeId;
  setTheme: (id: ThemeId) => void;
};

export function SettingsPane({ open, onClose, onLogout, theme, setTheme }: SettingsPaneProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<SettingsSection | null>("release");

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setActiveSection("release");
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 md:inset-4 z-[70] flex flex-col overflow-hidden rounded-none md:rounded-sm border border-border bg-card text-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Dispatch settings and release manager</DialogPrimitive.Description>

          {/* Header */}
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            {/* Mobile back button when viewing a section */}
            {activeSection !== null && (
              <button
                onClick={() => setActiveSection(null)}
                className="mr-2 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {activeSection !== null ? (
                <span className="md:hidden">{SECTIONS.find((s) => s.id === activeSection)?.label ?? "Settings"}</span>
              ) : null}
              <span className={activeSection !== null ? "hidden md:inline" : ""}>Settings</span>
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Desktop nav — always visible */}
            <nav className="hidden md:flex w-40 shrink-0 flex-col border-r border-border py-2">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <div
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-4 py-2.5 text-sm transition-colors",
                    activeSection === id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {label}
                </div>
              ))}
            </nav>

            {/* Mobile nav — section list, shown when no section selected */}
            {activeSection === null && (
              <nav className="flex flex-1 flex-col md:hidden">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveSection(id)}
                    className="flex items-center gap-3 border-b border-border px-5 py-3.5 text-sm text-foreground transition-colors active:bg-muted"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {label}
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </nav>
            )}

            {/* Content */}
            <div className={cn("min-h-0 min-w-0 flex-1", activeSection === null && "hidden md:block")}>
              {activeSection === "release" && <ReleaseManager />}
              {activeSection === "security" && <SecuritySettings onLogout={onLogout} />}
              {activeSection === "notifications" && <NotificationSettings />}
              {activeSection === "appearance" && <AppearanceSettings theme={theme} setTheme={setTheme} />}
              {activeSection === "app" && <AppSettings />}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
