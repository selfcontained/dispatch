import { useAtom, useSetAtom } from "jotai";
import { Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
    <div>
      <h3 className="mb-1.5 section-label">Sound Cues</h3>
      <p className="mb-3 text-body-md text-muted-foreground">
        Soft tones when an agent needs input or a turn fails, plus mobile
        toolbar taps. This device only.
      </p>
      <div className="max-w-lg space-y-3">
        <SettingRow label="Enable">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="sound-cues-enabled"
          />
        </SettingRow>
        {enabled && (
          <div className="grid grid-cols-2 gap-2 pl-1">
            {CUE_INTENTS.map(({ intent, label }) => (
              <Button
                key={intent}
                size="sm"
                onClick={() => playCueForIntent(intent)}
                data-testid={`sound-preview-${intent}`}
              >
                <Play />
                {label}
              </Button>
            ))}
            <Button
              size="sm"
              onClick={() => playTapCue()}
              data-testid="sound-preview-tap"
            >
              <Play />
              Mobile tap
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function TipsSection(): JSX.Element {
  const [enabled, setEnabled] = useAtom(tipsEnabledAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);
  const setLastSeenVersion = useSetAtom(lastSeenVersionAtom);

  return (
    <div>
      <h3 className="mb-1.5 section-label">Tips & Guidance</h3>
      <p className="mb-3 text-body-md text-muted-foreground">
        Contextual tips that highlight features and link to docs. This device
        only.
      </p>
      <div className="max-w-lg space-y-3">
        <SettingRow label="Show tips">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="tips-enabled"
          />
        </SettingRow>
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
      </div>
    </div>
  );
}
