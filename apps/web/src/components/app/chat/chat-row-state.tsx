import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export type ChatRowState = Map<string, unknown>;
export const ChatRowStateContext = createContext<ChatRowState | null>(null);

// Owned by the feed, so offscreen rows can unmount without losing disclosures.
export function useChatRowState<T>(
  key: string,
  initial: T
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(ChatRowStateContext);
  const [value, setValue] = useState<T>(() =>
    cache?.has(key) ? (cache.get(key) as T) : initial
  );
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((previous) => {
        const result =
          typeof next === "function"
            ? (next as (value: T) => T)(previous)
            : next;
        cache?.set(key, result);
        return result;
      });
    },
    [cache, key]
  );
  return [value, update];
}
