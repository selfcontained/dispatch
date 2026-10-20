import { useId } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
      {arg.options ? (
        <div className="flex items-center gap-2">
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id={inputId} className="h-8 text-sm">
              <SelectValue placeholder={`Choose ${arg.name}`} />
            </SelectTrigger>
            <SelectContent>
              {[...new Set(arg.options)].filter(Boolean).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!arg.required && value !== "" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Clear ${arg.name}`}
              onClick={() => onChange("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : arg.multiline ? (
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
      {arg.error ? (
        <p role="alert" className="text-xs text-status-blocked">
          {arg.error}
        </p>
      ) : null}
    </div>
  );
}
