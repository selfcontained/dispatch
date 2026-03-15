import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronRight, ArrowLeft, ArrowDownToLine, X } from "lucide-react";

import { ReleaseManager } from "@/components/app/release-manager";
import { cn } from "@/lib/utils";

type SettingsSection = "release";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof ArrowDownToLine }> = [
  { id: "release", label: "Updates", icon: ArrowDownToLine }
];

type SettingsPaneProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsPane({ open, onClose }: SettingsPaneProps): JSX.Element {
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
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
