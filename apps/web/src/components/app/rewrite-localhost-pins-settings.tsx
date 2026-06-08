import { Checkbox } from "@/components/ui/checkbox";
import { useRewriteLocalhostPins } from "@/hooks/use-rewrite-localhost-pins";
import { extractHostname } from "@/lib/rewrite-pin-url";
import { cn } from "@/lib/utils";

export function RewriteLocalhostPinsSettings(): JSX.Element {
  const { enabled, setEnabled } = useRewriteLocalhostPins();
  const host =
    typeof window === "undefined" ? "" : extractHostname(window.location.host);

  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Pin links
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Rewrite{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          localhost
        </code>{" "}
        in pinned URLs to{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {host}
        </code>
        . Saved on this device.
      </p>
      <label
        className={cn(
          "flex max-w-lg items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors",
          "cursor-pointer hover:bg-muted/50"
        )}
      >
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => setEnabled(v === true)}
          data-testid="rewrite-localhost-pins-toggle"
        />
        <div className="min-w-0 text-sm font-medium text-foreground">
          Rewrite localhost in pins
        </div>
      </label>
    </div>
  );
}
