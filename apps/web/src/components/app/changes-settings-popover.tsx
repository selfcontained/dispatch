import { useAtom } from "jotai";
import { Settings } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { TipSpot } from "@/components/tips/tip-spot";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { IconButton } from "@/components/ui/icon-button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  type DiffViewType,
  diffViewTypeAtom,
  diffIgnoreWhitespaceAtom,
  diffIncludeUncommittedAtom,
  diffHideTestFilesAtom,
} from "@/lib/store";

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
          <IconButton
            label="Diff settings"
            data-testid="changes-settings-button"
          >
            <Settings />
          </IconButton>
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" className="w-64 p-3">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <span className="section-label">Diff view</span>
              <SegmentedControl
                layout="fill"
                aria-label="Diff view"
                aria-describedby={
                  isMobile ? "mobile-diff-view-hint" : undefined
                }
                value={effectiveViewType}
                onValueChange={(next) => {
                  if (!isMobile) setViewType(next);
                }}
              >
                {VIEW_OPTIONS.map((opt) => (
                  <SegmentedControlItem
                    key={opt.value}
                    value={opt.value}
                    disabled={isMobile && opt.value === "split"}
                  >
                    {opt.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              {isMobile ? (
                <p
                  id="mobile-diff-view-hint"
                  className="text-label-sm text-muted-foreground"
                >
                  Split view is available on larger screens.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <span className="section-label">Changes</span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={includeUncommitted}
                  onCheckedChange={(v) => setIncludeUncommitted(v === true)}
                  data-testid="changes-include-uncommitted"
                />
                <span className="whitespace-nowrap text-body-sm text-foreground">
                  Include uncommitted changes
                </span>
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="section-label">Whitespace</span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={ignoreWhitespace}
                  onCheckedChange={(v) => setIgnoreWhitespace(v === true)}
                  data-testid="changes-ignore-whitespace"
                />
                <span className="whitespace-nowrap text-body-sm text-foreground">
                  Hide whitespace changes
                </span>
              </label>
            </div>
            <div className="space-y-1.5">
              <span className="section-label">Files</span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={hideTestFiles}
                  onCheckedChange={(v) => setHideTestFiles(v === true)}
                  data-testid="changes-hide-test-files"
                />
                <span className="whitespace-nowrap text-body-sm text-foreground">
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
