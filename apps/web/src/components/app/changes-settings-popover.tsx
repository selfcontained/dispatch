import { useAtom } from "jotai";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const VIEW_OPTIONS: { value: DiffViewType; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

export function ChangesSettingsPopover(): JSX.Element {
  const [viewType, setViewType] = useAtom(diffViewTypeAtom);
  const [ignoreWhitespace, setIgnoreWhitespace] = useAtom(
    diffIgnoreWhitespaceAtom
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          title="Diff settings"
          data-testid="changes-settings-button"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-56 p-3">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Diff view
            </span>
            <div
              role="group"
              aria-label="Diff view"
              className="flex rounded-md border border-border/60 bg-muted/30 p-0.5"
            >
              {VIEW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={viewType === opt.value}
                  className={cn(
                    "flex-1 rounded-[3px] px-2 py-1 text-xs font-medium transition-colors",
                    viewType === opt.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => setViewType(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Whitespace
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={ignoreWhitespace}
                onCheckedChange={(v) => setIgnoreWhitespace(v === true)}
                data-testid="changes-ignore-whitespace"
              />
              <span className="text-xs text-foreground">
                Hide whitespace changes
              </span>
            </label>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
