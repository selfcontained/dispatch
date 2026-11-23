import { useAtom, useSetAtom } from "jotai";
import { Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsGroup } from "@/components/app/settings-layout";
import { soundCuesEnabledAtom } from "@/lib/store";
import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "@/lib/tips/tips-state";
import { CUE_INTENTS, playCueForIntent, playTapCue } from "@/lib/sound-cues";
import { SettingRow } from "@/components/ui/setting-row";
import { toast } from "@/components/ui/toast";

export function SoundCuesSection(): JSX.Element {
  const [enabled, setEnabled] = useAtom(soundCuesEnabledAtom);
  return (
    <SettingsGroup
      title="Sound cues"
      description="Soft tones when an agent needs input or a turn fails, plus mobile toolbar taps. This device only."
    >
      <SettingRow
        label="Play sound cues"
        details={
          enabled ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CUE_INTENTS.map(({ intent, label }) => (
                <Button
                  key={intent}
                  size="sm"
                  wrap
                  onClick={() => playCueForIntent(intent)}
                  data-testid={`sound-preview-${intent}`}
                >
                  <Play />
                  {label}
                </Button>
              ))}
              <Button
                size="sm"
                wrap
                onClick={() => playTapCue()}
                data-testid="sound-preview-tap"
              >
                <Play />
                Mobile tap
              </Button>
            </div>
          ) : null
        }
      >
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid="sound-cues-enabled"
        />
      </SettingRow>
    </SettingsGroup>
  );
}

export function TipsSection(): JSX.Element {
  const [enabled, setEnabled] = useAtom(tipsEnabledAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);
  const setLastSeenVersion = useSetAtom(lastSeenVersionAtom);

  return (
    <SettingsGroup
      title="Tips and guidance"
      description="Contextual tips that highlight features and link to docs. This device only."
    >
      <SettingRow label="Show tips">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          data-testid="tips-enabled"
        />
      </SettingRow>
      <SettingRow
        layout="action"
        label="Dismissed tips"
        description="Reset them to see each tip again."
      >
        <Button
          size="sm"
          onClick={() => {
            setDismissed([]);
            setLastSeenVersion("0.0.0");
            toast.success("Tips reset.", {
              description: "You’ll see them again as you use the app.",
            });
          }}
          data-testid="reset-dismissed-tips"
        >
          <RotateCcw />
          Reset dismissed tips
        </Button>
      </SettingRow>
    </SettingsGroup>
  );
}
