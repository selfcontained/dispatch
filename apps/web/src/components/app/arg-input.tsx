import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TemplateArg } from "@/hooks/use-templates";

export function ArgInput({
  arg,
  value,
  onChange,
}: {
  arg: TemplateArg;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputId = useId();

  return (
    <div className="space-y-2">
      <label htmlFor={inputId} className="text-sm text-muted-foreground">
        {arg.name}
        {arg.required ? (
          <span className="ml-1 text-status-blocked">*</span>
        ) : null}
      </label>
      {arg.multiline ? (
        <Textarea
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
          className="min-h-24 resize-y text-sm"
        />
      ) : (
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
          className="h-8 text-sm"
        />
      )}
    </div>
  );
}
