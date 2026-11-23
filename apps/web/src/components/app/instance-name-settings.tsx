import { useInstanceName } from "@/hooks/use-instance-name";
import { useAutoSave } from "@/hooks/use-auto-save";
import { useTextSetting } from "@/hooks/use-text-setting";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/async-boundary";
import { SettingRow } from "@/components/ui/setting-row";

export function InstanceNameSettings(): JSX.Element {
  const { instanceName, loaded, loadError, retryLoad, saveInstanceName } =
    useInstanceName();
  const autoSave = useAutoSave<string, "name">((_, name) =>
    saveInstanceName(name)
  );
  const field = useTextSetting({
    name: "name",
    saved: instanceName,
    autoSave,
  });

  return (
    <SettingsGroup title="Instance">
      <SettingRow
        id="instance-name"
        layout="field"
        label="Instance name"
        description="Tells this Dispatch apart from others, in the sidebar and browser tab."
        status={field.status}
      >
        <Input
          type="text"
          {...field.inputProps}
          disabled={!loaded}
          placeholder="e.g. Production, Staging, Local"
          maxLength={100}
        />
      </SettingRow>
      {loadError ? (
        <LoadError
          thing="the instance name"
          error={loadError}
          onRetry={retryLoad}
        />
      ) : null}
    </SettingsGroup>
  );
}
