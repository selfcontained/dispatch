import { useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type ServerFlagResponse,
  serverFlagQueryKey,
  useServerFlag,
} from "@/hooks/use-server-flag";
import { api } from "@/lib/api";
import { chatSurfaceEnabledHintAtom } from "@/lib/store";

export const CHAT_SURFACE_ENDPOINT = "/api/v1/app/settings/chat-surface";
const CHAT_SURFACE_QUERY_KEY = serverFlagQueryKey(CHAT_SURFACE_ENDPOINT);

type ToggleSettingResponse = ServerFlagResponse;

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

export type ChatSurfaceSetting = {
  /** The confirmed value, or the optimistic one while a write is in flight. */
  enabled: boolean;
  /** False until either the fetch or a toggle has produced a value. */
  loaded: boolean;
  /** Empty string when there is nothing to report. */
  error: string;
  setEnabled: (next: boolean) => void;
};

/**
 * The settings-page toggle for the flag. One state machine over the same
 * query `useChatSurfaceEnabled` reads: the GET is the query's own fetch, a
 * toggle writes the optimistic value straight into the cache and cancels any
 * GET still in flight (so a slow initial fetch cannot land after a successful
 * toggle and revert it), and a failed POST rolls the cache back to the last
 * confirmed value. Nothing here fetches on its own.
 *
 * Writes are sequence-guarded: only the newest toggle's outcome touches the
 * cache, so two quick flips cannot leave the UI on the older value.
 */
export function useChatSurfaceSetting(): ChatSurfaceSetting {
  const queryClient = useQueryClient();
  const { enabled, loaded } = useChatSurfaceEnabled();
  const { isError: loadFailed } = useQuery<ToggleSettingResponse>({
    queryKey: CHAT_SURFACE_QUERY_KEY,
    queryFn: () => api<ToggleSettingResponse>(CHAT_SURFACE_ENDPOINT),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const latestWrite = useRef(0);

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api<ToggleSettingResponse>(CHAT_SURFACE_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ enabled: next }),
      }),
    onMutate: async (next) => {
      const seq = (latestWrite.current += 1);
      // A GET still in flight would otherwise resolve after this toggle and
      // overwrite the optimistic value with the pre-toggle one.
      await queryClient.cancelQueries({ queryKey: CHAT_SURFACE_QUERY_KEY });
      const previous = queryClient.getQueryData<ToggleSettingResponse>(
        CHAT_SURFACE_QUERY_KEY
      );
      queryClient.setQueryData<ToggleSettingResponse>(CHAT_SURFACE_QUERY_KEY, {
        enabled: next,
      });
      return { seq, previous };
    },
    onSuccess: (data, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      queryClient.setQueryData<ToggleSettingResponse>(
        CHAT_SURFACE_QUERY_KEY,
        data
      );
    },
    onError: (_error, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      if (context.previous !== undefined) {
        queryClient.setQueryData(CHAT_SURFACE_QUERY_KEY, context.previous);
      } else {
        // Nothing confirmed to fall back to: let the query fetch it again.
        void queryClient.invalidateQueries({
          queryKey: CHAT_SURFACE_QUERY_KEY,
        });
      }
    },
  });

  const { mutate, reset } = mutation;
  const setEnabled = useCallback(
    (next: boolean) => {
      reset();
      mutate(next);
    },
    [mutate, reset]
  );

  const error = mutation.isError
    ? mutation.error instanceof Error && mutation.error.message
      ? mutation.error.message
      : "Failed to save chat surface setting."
    : loadFailed && !loaded
      ? "Failed to load chat surface setting."
      : "";

  return { enabled, loaded, error, setEnabled };
}
