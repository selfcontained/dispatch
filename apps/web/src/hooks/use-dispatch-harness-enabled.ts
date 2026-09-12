import {
  type ServerFlagSetting,
  useServerFlag,
  useServerFlagSetting,
} from "@/hooks/use-server-flag";
import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

export const DISPATCH_HARNESS_ENDPOINT =
  "/api/v1/app/settings/dispatch-harness";

/**
 * The `dispatch_harness_enabled` feature flag: whether the Dispatch Harness
 * agent type is on offer. `dispatch` is never a member of the enabled
 * agent types the server persists, so this flag is the only thing that puts
 * the type in the create dialog, the sidebar picker, jobs, templates and the
 * reviewer pickers.
 *
 * `dispatchHarnessEnabledHintAtom` stands in for the value until the first
 * fetch resolves, so the type does not appear and then vanish on first paint.
 * The settings toggle (`useDispatchHarnessSetting`) writes through the same
 * query, so the pickers react the moment the user flips it.
 *
 * The flag gates creation and discovery only: a running dispatch agent keeps
 * running and keeps its pane when the flag goes off.
 */
export function useDispatchHarnessEnabled(): {
  enabled: boolean;
  loaded: boolean;
} {
  return useServerFlag(
    DISPATCH_HARNESS_ENDPOINT,
    dispatchHarnessEnabledHintAtom
  );
}

/** The settings-page toggle for the flag. See `useServerFlagSetting`. */
export function useDispatchHarnessSetting(): ServerFlagSetting {
  return useServerFlagSetting(
    DISPATCH_HARNESS_ENDPOINT,
    dispatchHarnessEnabledHintAtom,
    {
      save: "Failed to save Dispatch Harness setting.",
      load: "Failed to load Dispatch Harness setting.",
    }
  );
}
