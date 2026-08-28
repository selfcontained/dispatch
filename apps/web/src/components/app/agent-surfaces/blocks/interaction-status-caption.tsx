import { RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Tone } from "@/components/app/agent-surfaces/types";
import { TONE_CLASSES } from "@/components/app/agent-surfaces/tone";
import type { InteractionCaption } from "@/components/app/agent-surfaces/interaction-presentation";

/**
 * Caption colour per outcome tone. Reuses the shared surface tone palette so
 * a declined interaction reads the same red as a danger status block, except
 * for `neutral`, which recedes to muted — a caption is secondary text, not a
 * full-strength foreground line.
 */
const CAPTION_TONE_CLASS: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  info: TONE_CLASSES.info.text,
  success: TONE_CLASSES.success.text,
  warning: TONE_CLASSES.warning.text,
  danger: TONE_CLASSES.danger.text,
};

/**
 * Renders one resolved `InteractionCaption`. Pending and outcome captions are
 * `role="status"` so a screen reader hears the state change politely when the
 * agent resolves an interaction over SSE without the user having done
 * anything; a failed POST is `role="alert"` because it is the user's own
 * action that just failed and needs interrupting for.
 *
 * The status word leads the sentence (`Declined — not enough context`) so the
 * outcome is the first thing announced, with the agent's own message as the
 * explanation after it.
 */
function InteractionStatusCaption({
  caption,
  onReload,
}: {
  caption: InteractionCaption;
  onReload?: () => void;
}): JSX.Element {
  if (caption.kind === "error") {
    return (
      <p
        role="alert"
        data-testid="interaction-status-caption"
        data-caption-kind="error"
        className="mt-1 flex items-center gap-1.5 text-[11px] text-status-blocked"
      >
        <span>{caption.message}</span>
        {onReload ? (
          <button
            type="button"
            onClick={onReload}
            className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:no-underline"
          >
            <RotateCcw className="h-3 w-3" /> Reload
          </button>
        ) : null}
      </p>
    );
  }

  const toneClass =
    caption.kind === "outcome"
      ? CAPTION_TONE_CLASS[caption.tone]
      : "text-muted-foreground";

  return (
    <p
      role="status"
      data-testid="interaction-status-caption"
      data-caption-kind={caption.kind}
      data-interaction-status={caption.status}
      className={cn("mt-1 text-[11px]", toneClass)}
    >
      {caption.message
        ? `${caption.label} — ${caption.message}`
        : `${caption.label}.`}
    </p>
  );
}

/**
 * True when an action/submit's `disabledReason` should be shown in place of
 * the interaction caption: there is no interaction state worth reporting, the
 * control is authored-disabled, and a reason was provided. Exported so callers
 * can compute the same id up front for the button's `aria-describedby`, ahead
 * of `ActionFeedback` deciding whether the paragraph that id points at
 * actually renders.
 */
export function showsDisabledReason(
  caption: InteractionCaption | null,
  disabled: boolean,
  disabledReason: string | undefined
): disabledReason is string {
  return caption === null && disabled && !!disabledReason;
}

/**
 * Renders the disabled-reason-or-status footer shared by actions-block (one
 * per action, keyed) and form-block (one for the whole form): the authored
 * `disabledReason` text when there is no interaction to report, otherwise the
 * pending/outcome/error caption resolved from the durable record plus this
 * tab's local submission state.
 */
export function ActionFeedback({
  id,
  caption,
  disabled,
  disabledReason,
  onReload,
}: {
  id: string;
  caption: InteractionCaption | null;
  disabled: boolean;
  disabledReason: string | undefined;
  onReload?: () => void;
}): JSX.Element | null {
  if (showsDisabledReason(caption, disabled, disabledReason)) {
    return (
      <p
        id={id}
        data-testid="action-disabled-reason"
        className="mt-1 text-[11px] text-muted-foreground"
      >
        {disabledReason}
      </p>
    );
  }
  if (!caption) return null;
  return <InteractionStatusCaption caption={caption} onReload={onReload} />;
}
