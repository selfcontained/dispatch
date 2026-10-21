import { createContext, useCallback, useContext, useState } from "react";

// Owned by the lightweight file section, which outlives its viewport contents.
// This keeps editor buffers without retaining parsed tables or global state.
export const DiffEditorStateContext = createContext<Map<
  string,
  unknown
> | null>(null);

export function useDiffEditorState<T extends string | boolean>(
  key: string,
  initial: T
) {
  const buffers = useContext(DiffEditorStateContext);
  const [value, setValue] = useState<T>(
    () => (buffers?.get(key) as T | undefined) ?? initial
  );
  const update = useCallback(
    (next: T) => {
      buffers?.set(key, next);
      setValue(next);
    },
    [buffers, key]
  );
  return [value, update] as const;
}
