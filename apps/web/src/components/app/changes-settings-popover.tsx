import { useAtom } from "jotai";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TipSpot } from "@/components/tips/tip-spot";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffIncludeUncommittedAtom,
  diffHideTestFilesAtom,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const VIEW_OPTIONS: { value: DiffViewType; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

type ChangesSettingsPopoverProps = {
  isMobile?: boolean;
};

export function ChangesSettingsPopover({
  isMobile = false,
}: ChangesSettingsPopoverProps): JSX.Element {
  const [viewType, setViewType] = useAtom(diffViewTypeAtom);
  const effectiveViewType = isMobile ? "unified" : viewType;
  const [ignoreWhitespace, setIgnoreWhitespace] = useAtom(
    diffIgnoreWhitespaceAtom
  );
  const [includeUncommitted, setIncludeUncommitted] = useAtom(
    diffIncludeUncommittedAtom
  );
  const [hideTestFiles, setHideTestFiles] = useAtom(diffHideTestFilesAtom);

  return (
    <TipSpot tipId="uncommitted-diff" side="bottom" align="end" sideOffset={4}>
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
        <PopoverContent align="end" side="bottom" className="w-64 p-3">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Diff view
              </span>
              <div
                role="group"
                aria-label="Diff view"
                aria-describedby={
                  isMobile ? "mobile-diff-view-hint" : undefined
                }
                className="flex rounded-md border border-border/60 bg-muted/30 p-0.5"
              >
                {VIEW_OPTIONS.map((opt) => {
                  const disabled = isMobile && opt.value === "split";
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={disabled}
                      aria-pressed={effectiveViewType === opt.value}
                      className={cn(
                        "flex-1 rounded-[3px] px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        effectiveViewType === opt.value
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      onClick={() => {
                        if (!isMobile) setViewType(opt.value);
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {isMobile ? (
                <p
                  id="mobile-diff-view-hint"
                  className="text-[11px] text-muted-foreground"
                >
                  Split view is available on larger screens.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Changes
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={includeUncommitted}
                  onCheckedChange={(v) => setIncludeUncommitted(v === true)}
                  data-testid="changes-include-uncommitted"
                />
                <span className="whitespace-nowrap text-xs text-foreground">
                  Include uncommitted changes
                </span>
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Whitespace
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={ignoreWhitespace}
                  onCheckedChange={(v) => setIgnoreWhitespace(v === true)}
                  data-testid="changes-ignore-whitespace"
                />
                <span className="whitespace-nowrap text-xs text-foreground">
                  Hide whitespace changes
                </span>
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Files
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={hideTestFiles}
                  onCheckedChange={(v) => setHideTestFiles(v === true)}
                  data-testid="changes-hide-test-files"
                />
                <span className="whitespace-nowrap text-xs text-foreground">
                  Hide test files
                </span>
              </label>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </TipSpot>
  );
}
