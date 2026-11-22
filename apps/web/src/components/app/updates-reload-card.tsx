import { RefreshCw, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
    <div>
      <div className="mb-1.5 section-label">Reload</div>
      <p className="mb-3 text-body-md text-muted-foreground">
        Reload the app to pick up the latest version.
      </p>
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
    </div>
  );
}
