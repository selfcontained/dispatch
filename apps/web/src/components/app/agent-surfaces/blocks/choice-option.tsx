import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { FormFieldOption } from "@/components/app/agent-surfaces/types";

export function ChoiceOptionContent({
  option,
  htmlFor,
}: {
  option: FormFieldOption;
  htmlFor: string;
}): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="min-w-0 text-xs text-foreground">
      <span className="block">{option.label}</span>
      {option.description ? (
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {option.description}
        </span>
      ) : null}
    </label>
  );
}

export function ChoiceOptionRow({
  option,
  optionId,
  control,
}: {
  option: FormFieldOption;
  optionId: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div
      data-choice-option
      className={cn(
        // 1rem/h-4 track matches both control kinds rendered here (radio
        // input and multi-select Checkbox — see form-fields.tsx), so
        // neither clips or floats off-center against the other. The coarse
        // (touch) variants grow the row's tap target to the 44px minimum
        // without enlarging the visible track.
        "grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:py-1",
        option.disabled && "opacity-60"
      )}
    >
      <div className="flex h-4 w-4 items-center justify-center">{control}</div>
      <ChoiceOptionContent option={option} htmlFor={optionId} />
    </div>
  );
}
