import { useAtom, useSetAtom } from "jotai";
import { Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { soundCuesEnabledAtom } from "@/lib/store";
import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "@/lib/tips/tips-state";
import { CUE_INTENTS, playCueForIntent, playTapCue } from "@/lib/sound-cues";

export function SoundCuesSection(): JSX.Element {
  const [enabled, setEnabled] = useAtom(soundCuesEnabledAtom);
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Sound Cues
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        Soft tones for agent status changes and mobile toolbar taps. This device
        only.
      </p>
      <div className="max-w-lg space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="sound-cues-enabled"
          />
          <div className="text-sm font-medium text-foreground">Enable</div>
        </label>
        {enabled && (
          <div className="grid grid-cols-2 gap-2 pl-1">
            {CUE_INTENTS.map(({ intent, label }) => (
              <Button
                key={intent}
                variant="default"
                size="sm"
                onClick={() => playCueForIntent(intent)}
                data-testid={`sound-preview-${intent}`}
                className="gap-1.5"
              >
                <Play className="h-3 w-3" />
                {label}
              </Button>
            ))}
            <Button
              variant="default"
              size="sm"
              onClick={() => playTapCue()}
              data-testid="sound-preview-tap"
              className="gap-1.5"
            >
              <Play className="h-3 w-3" />
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
      <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Tips & Guidance
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        Contextual tips that highlight features and link to docs. This device
        only.
      </p>
      <div className="max-w-lg space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="tips-enabled"
          />
          <div className="text-sm font-medium text-foreground">Show tips</div>
        </label>
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            setDismissed([]);
            setLastSeenVersion("0.0.0");
            toast.success(
              "Tips reset — you'll see them again as you use the app."
            );
          }}
          data-testid="reset-dismissed-tips"
          className="gap-1.5"
        >
          <RotateCcw className="h-3 w-3" />
          Reset dismissed tips
        </Button>
      </div>
    </div>
  );
}
