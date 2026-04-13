import React from "react";

export function useTemporaryState<T>(initialValue: T, durationMs: number): readonly [T, (value: T) => void] {
  const [value, setValue] = React.useState(initialValue);

  React.useEffect(() => {
    if (Object.is(value, initialValue)) return;

    const timeoutId = window.setTimeout(() => {
      setValue(initialValue);
    }, durationMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [durationMs, initialValue, value]);

  return [value, setValue] as const;
}
