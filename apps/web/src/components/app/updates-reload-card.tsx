import { ChevronDown, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Reload
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Reload the app to pick up the latest version.
      </p>
      <div className="inline-flex items-center">
        <Button
          size="sm"
          variant="default"
          onClick={onReload}
          className="rounded-r-none border-r-0 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Reload
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="default"
              className="rounded-l-none border-l border-white/[0.12] px-1 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={onClearCacheAndReload}
              className="flex items-center whitespace-nowrap text-muted-foreground"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Clear cache & reload
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
