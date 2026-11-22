import { RefreshCw, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SettingsGroup } from "@/components/app/settings-layout";
import { SettingRow } from "@/components/ui/setting-row";
import { SplitButton } from "@/components/ui/split-button";

type UpdatesReloadCardProps = {
  onReload: () => void;
  onClearCacheAndReload: () => void;
};

/** Split reload button — plain reload, with cache-clearing reload behind the caret. */
export function UpdatesReloadCard({
  onReload,
  onClearCacheAndReload,
}: UpdatesReloadCardProps): JSX.Element {
  return (
    <SettingsGroup title="Reload">
      <SettingRow
        layout="action"
        label="Reload the app"
        description="Picks up the latest version."
      >
        <SplitButton
          size="sm"
          onClick={onReload}
          menuLabel="More reload options"
          menu={
            <DropdownMenuItem
              onClick={onClearCacheAndReload}
              className="flex items-center whitespace-nowrap text-muted-foreground"
            >
              <Trash2 className="mr-2 size-icon-md" />
              Clear cache & reload
            </DropdownMenuItem>
          }
        >
          <RefreshCw />
          Reload
        </SplitButton>
      </SettingRow>
    </SettingsGroup>
  );
}
