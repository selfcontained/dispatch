import { Switch } from "@/components/ui/switch";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { SettingRow, type SaveStatus } from "@/components/ui/setting-row";
import { SettingsGroup } from "@/components/app/settings-layout";
import type { ReleaseChannel } from "@/hooks/use-release-stream";

type UpdatesPreferencesProps = {
  channel: ReleaseChannel;
  channelStatus: SaveStatus;
  onChannelChange: (channel: ReleaseChannel) => void;
  autoUpdateMode: "off" | "check";
  autoUpdateStatus: SaveStatus;
  onAutoUpdateModeChange: (mode: "off" | "check") => void;
};

/**
 * The two persisted update preferences — which channel this instance
 * follows, and whether it polls for new releases on its own.
 */
export function UpdatesPreferences({
  channel,
  channelStatus,
  onChannelChange,
  autoUpdateMode,
  autoUpdateStatus,
  onAutoUpdateModeChange,
}: UpdatesPreferencesProps): JSX.Element {
  return (
    <SettingsGroup title="Preferences">
      <SettingRow
        layout="action"
        label="Release channel"
        description="Stable gets promoted releases. Preview gets every release as soon as it ships."
        status={channelStatus}
      >
        <SegmentedControl
          aria-label="Release channel"
          value={channel}
          onValueChange={onChannelChange}
        >
          <SegmentedControlItem value="stable">Stable</SegmentedControlItem>
          <SegmentedControlItem value="preview">Preview</SegmentedControlItem>
        </SegmentedControl>
      </SettingRow>
      <SettingRow
        label="Check for updates automatically"
        description="Dispatch periodically checks for new releases and notifies you. Updates never install automatically."
        status={autoUpdateStatus}
      >
        <Switch
          checked={autoUpdateMode === "check"}
          onCheckedChange={(on) => onAutoUpdateModeChange(on ? "check" : "off")}
          data-testid="auto-update-mode-switch"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
