import { Checkbox } from "@/components/ui/checkbox";
import { useChatSurfaceSetting } from "@/hooks/use-chat-surface-enabled";

/**
 * Toggle for the Chat surface beta. Server-owned like the other flags (GET on
 * mount, POST on explicit toggle), but it lives in the React Query cache that
 * the tab bar and routing read, so flipping it here re-labels the tabs
 * without a reload. See `useChatSurfaceSetting` for the optimistic write.
 */
export function ChatSurfaceSettings(): JSX.Element {
  const { enabled, error, setEnabled } = useChatSurfaceSetting();

  return (
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Chat surface
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Adds a <strong>Chat</strong> tab above each agent&apos;s terminal where
        you read the agent&apos;s replies and type messages back. The terminal
        stays one click away as the <strong>Console</strong>. Agents are told to
        answer in the Chat tab; anything they only print in the terminal stays
        in the Console.
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="chat-surface-toggle"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Chat surface (beta)
            </div>
            <div className="text-xs text-muted-foreground">
              When on, agents open on a Chat tab and the terminal tab is
              labelled Console. When off, nothing changes.
            </div>
          </div>
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
