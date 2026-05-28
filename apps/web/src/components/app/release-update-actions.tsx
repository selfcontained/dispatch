import { ArrowDownToLine, Bot, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type UpdateActionsProps = {
  tag: string;
  assistedPreferred: boolean;
  forceRequired: boolean;
  assistedLaunching: boolean;
  onStandardUpdate: () => void;
  onAssistedUpdate: () => void;
  onForceStandardUpdate: () => void;
};

export function UpdateActions({
  tag,
  assistedPreferred,
  forceRequired,
  assistedLaunching,
  onStandardUpdate,
  onAssistedUpdate,
  onForceStandardUpdate,
}: UpdateActionsProps): JSX.Element {
  const standardLabel = `Update to ${tag}`;
  const assistedLabel = assistedLaunching
    ? "Launching agent..."
    : "Agent-assisted update";
  const assistedDescription = "Agent runs and validates each step";

  const standardMenuLabel = forceRequired ? `${standardLabel}…` : standardLabel;

  if (assistedPreferred) {
    return (
      <div className="inline-flex items-center self-start">
        <Button
          variant="primary"
          disabled={assistedLaunching}
          onClick={onAssistedUpdate}
          className="rounded-r-none border-r-0"
          data-testid="assisted-update-button"
        >
          {assistedLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="primary"
              disabled={assistedLaunching}
              className="rounded-l-none border-l border-white/[0.18] px-1"
              aria-label="More update options"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() =>
                forceRequired ? onForceStandardUpdate() : onStandardUpdate()
              }
              className="flex items-center gap-2.5 text-foreground"
              data-testid="standard-update-menu-item"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {standardMenuLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center self-start">
      <Button
        variant="primary"
        disabled={assistedLaunching}
        onClick={onStandardUpdate}
        className="rounded-r-none border-r-0"
        data-testid="standard-update-button"
      >
        {standardLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="primary"
            disabled={assistedLaunching}
            className="rounded-l-none border-l border-white/[0.18] px-1"
            aria-label="More update options"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={assistedLaunching}
            onClick={onAssistedUpdate}
            className="flex items-start gap-2.5 text-foreground"
            data-testid="assisted-update-menu-item"
          >
            <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="flex flex-col">
              <span>{assistedLabel}</span>
              <span className="text-xs text-muted-foreground">
                {assistedDescription}
              </span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
