import * as React from "react";

export type FieldControl = {
  id: string;
  describedBy?: string;
  /** Set where the label also holds a description, as in SettingRow. */
  labelledBy?: string;
  invalid?: boolean;
  required?: boolean;
};

export const FieldContext = React.createContext<FieldControl | null>(null);

type ControlProps = {
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "aria-required"?: React.AriaAttributes["aria-required"];
};

/** Joins a control to the Field or SettingRow around it. Its own props win. */
export function useFieldControl<P extends ControlProps>(props: P): P {
  const field = React.useContext(FieldContext);
  if (!field) return props;
  const describedBy = [props["aria-describedby"], field.describedBy]
    .filter(Boolean)
    .join(" ");
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-labelledby":
      props["aria-labelledby"] ??
      (props["aria-label"] ? undefined : field.labelledBy),
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
    "aria-required": props["aria-required"] ?? (field.required || undefined),
  };
}
