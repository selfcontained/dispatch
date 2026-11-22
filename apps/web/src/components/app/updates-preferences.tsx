import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ReleaseChannel } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";

type UpdatesPreferencesProps = {
  channel: ReleaseChannel;
  channelSaving: boolean;
  onChannelChange: (channel: ReleaseChannel) => void;
  autoUpdateMode: "off" | "check";
  autoUpdateSaving: boolean;
  onAutoUpdateModeChange: (mode: "off" | "check") => void;
};

/**
 * The two persisted update preferences — which channel this instance
 * follows, and whether it polls for new releases on its own.
 */
export function UpdatesPreferences({
  channel,
  channelSaving,
  onChannelChange,
  autoUpdateMode,
  autoUpdateSaving,
  onAutoUpdateModeChange,
}: UpdatesPreferencesProps): JSX.Element {
  return (
    <>
      <div>
        <div className="mb-1.5 section-label">Release channel</div>
        <p className="mb-3 text-body-md text-muted-foreground">
          Stable gets promoted releases. Preview gets every release as soon as
          it ships.
        </p>
        <SegmentedControl
          aria-label="Release channel"
          value={channel}
          disabled={channelSaving}
          onValueChange={onChannelChange}
        >
          <SegmentedControlItem value="stable">Stable</SegmentedControlItem>
          <SegmentedControlItem value="preview">Preview</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <div>
        <div className="mb-1.5 section-label">Automatic updates</div>
        <p className="mb-3 text-body-md text-muted-foreground">
          When on, Dispatch periodically checks for new releases and notifies
          you. Updates never install automatically.
        </p>
        <div
          className={cn(
            "inline-block min-w-[14rem]",
            autoUpdateSaving && "opacity-50 pointer-events-none"
          )}
        >
          <Select
            value={autoUpdateMode}
            onValueChange={(value) =>
              onAutoUpdateModeChange(value as "off" | "check")
            }
          >
            <SelectTrigger
              data-testid="auto-update-mode-select"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off" data-testid="auto-update-mode-off">
                Off
              </SelectItem>
              <SelectItem value="check" data-testid="auto-update-mode-check">
                Automatically check
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}
