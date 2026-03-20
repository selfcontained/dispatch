import { useCallback, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronRight, ArrowLeft, ArrowDownToLine, RefreshCw, Shield, X } from "lucide-react";

import { ReleaseManager } from "@/components/app/release-manager";
import { SecuritySettings } from "@/components/app/security-settings";
import { cn } from "@/lib/utils";

type SettingsSection = "release" | "security" | "app";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof ArrowDownToLine }> = [
  { id: "release", label: "Updates", icon: ArrowDownToLine },
  { id: "security", label: "Security", icon: Shield },
  { id: "app", label: "App", icon: RefreshCw }
];

function AppSettings(): JSX.Element {
  const [reloading, setReloading] = useState(false);

  const handleForceReload = useCallback(async () => {
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
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Force reload
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          If the app feels stuck on an old version, this will clear all cached data and reload with the latest version.
        </p>
        <button
          onClick={() => void handleForceReload()}
          disabled={reloading}
          className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", reloading && "animate-spin")} />
          {reloading ? "Reloading…" : "Clear cache & reload"}
        </button>
      </div>
    </div>
  );
}

type SettingsPaneProps = {
  open: boolean;
  onClose: () => void;
  onLogout: () => void;
};

export function SettingsPane({ open, onClose, onLogout }: SettingsPaneProps): JSX.Element {
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
              {activeSection === "app" && <AppSettings />}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
