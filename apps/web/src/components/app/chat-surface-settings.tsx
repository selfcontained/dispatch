import { ToggleSettingCard } from "@/components/app/toggle-setting-card";
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
    <ToggleSettingCard
      eyebrow="Chat surface"
      description={
        <>
          Adds a <strong>Chat</strong> tab above each agent&apos;s terminal
          where you read the agent&apos;s replies and type messages back. The
          terminal stays one click away as the <strong>Console</strong>. Agents
          are told to answer in the Chat tab; anything they only print in the
          terminal stays in the Console.
        </>
      }
      label="Chat surface (beta)"
      hint="When on, agents open on a Chat tab and the terminal tab is labelled Console. When off, nothing changes."
      testId="chat-surface-toggle"
      checked={enabled}
      onCheckedChange={setEnabled}
      error={error}
    />
  );
}
