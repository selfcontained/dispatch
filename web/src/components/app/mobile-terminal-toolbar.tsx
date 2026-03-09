import { Button } from "@/components/ui/button";

type TerminalHelper = {
  label: string;
  keyInput: string;
  ariaLabel: string;
};

const TERMINAL_HELPERS: TerminalHelper[] = [
  { label: "Ctrl+C", keyInput: "\u0003", ariaLabel: "Send Control C" },
  { label: "Tab", keyInput: "\t", ariaLabel: "Send Tab" },
  { label: "Esc", keyInput: "\u001b", ariaLabel: "Send Escape" },
  { label: "\u2191", keyInput: "\u001b[A", ariaLabel: "Send Arrow Up" },
  { label: "\u2193", keyInput: "\u001b[B", ariaLabel: "Send Arrow Down" },
  { label: "Enter", keyInput: "\r", ariaLabel: "Send Enter" }
];

type MobileTerminalToolbarProps = {
  onSendInput: (data: string) => void;
};

export function MobileTerminalToolbar({ onSendInput }: MobileTerminalToolbarProps): JSX.Element {
  return (
    <div className="border-t-2 border-border bg-[#12130f] px-2 py-2 md:hidden">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {TERMINAL_HELPERS.map((helper) => (
          <Button
            key={helper.label}
            type="button"
            size="sm"
            variant="default"
            className="h-8 shrink-0 px-3 text-xs"
            aria-label={helper.ariaLabel}
            onClick={() => onSendInput(helper.keyInput)}
          >
            {helper.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
