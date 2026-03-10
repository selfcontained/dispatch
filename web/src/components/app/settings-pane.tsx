import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Rocket, X } from "lucide-react";

import { ReleaseManager } from "@/components/app/release-manager";
import { cn } from "@/lib/utils";

type SettingsSection = "release";

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Rocket }> = [
  { id: "release", label: "Release", icon: Rocket }
];

type SettingsPaneProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsPane({ open, onClose }: SettingsPaneProps): JSX.Element {
  const activeSection: SettingsSection = "release";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-sm border border-border bg-card text-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Dispatch settings and release manager</DialogPrimitive.Description>

          {/* Header */}
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Settings</span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Nav */}
            <nav className="flex w-40 shrink-0 flex-col border-r border-border py-2">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <div
                  key={id}
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

            {/* Content */}
            <div className="min-h-0 min-w-0 flex-1">
              {activeSection === "release" && <ReleaseManager />}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
