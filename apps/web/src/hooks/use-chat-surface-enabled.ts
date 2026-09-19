import {
  type ServerFlagSetting,
  useServerFlag,
  useServerFlagSetting,
} from "@/hooks/use-server-flag";
import { chatSurfaceEnabledHintAtom } from "@/lib/store";

export const CHAT_SURFACE_ENDPOINT = "/api/v1/app/settings/chat-surface";

/**
 * The `chat_surface_enabled` feature flag: a `useServerFlag` over the
 * chat-surface endpoint, with `chatSurfaceEnabledHintAtom` standing in for
 * the value until the first fetch resolves so the first paint of an agent
 * already knows which tab to show. The settings toggle
 * (`useChatSurfaceSetting`) writes through the same query, so the tab bar
 * and routing react the moment the user flips it.
 */
export function useChatSurfaceEnabled(): { enabled: boolean; loaded: boolean } {
  return useServerFlag(CHAT_SURFACE_ENDPOINT, chatSurfaceEnabledHintAtom);
}

export type ChatSurfaceSetting = ServerFlagSetting;

/** The settings-page toggle for the flag. See `useServerFlagSetting`. */
export function useChatSurfaceSetting(): ChatSurfaceSetting {
  return useServerFlagSetting(
    CHAT_SURFACE_ENDPOINT,
    chatSurfaceEnabledHintAtom,
    {
      save: "Failed to save chat surface setting.",
      load: "Failed to load chat surface setting.",
    }
  );
}
