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
import { Field } from "@/components/ui/field";

export function ArgInput({
  arg,
  value,
  onChange,
}: {
  arg: TemplateArg;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <Field label={arg.name} required={arg.required} error={arg.error}>
      {arg.options ? (
        <div className="flex items-center gap-2">
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger>
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
          className="min-h-24 resize-y text-body-md"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${arg.name}`}
        />
      )}
    </Field>
  );
}
