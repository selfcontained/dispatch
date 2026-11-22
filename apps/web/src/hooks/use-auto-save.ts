import { useCallback, useEffect, useRef, useState } from "react";

import type { SaveStatus } from "@/components/ui/setting-row";

/** How long "Saved" shows. */
export const SAVED_NOTE_MS = 2000;

const IDLE: SaveStatus = { state: "idle" };

type Entry<V> = {
  state: "saving" | "saved" | "failed";
  value: V;
  error?: unknown;
};

export type SaveResult = { ok: true } | { ok: false; error: unknown };

/**
 * Settings that save as they change, one status per key.
 *
 * `write` sends one setting and updates what is known to be saved once the
 * server confirms; it runs when its turn comes, so it should read what is
 * saved then. Saves run in order, so settings sharing one payload never
 * overwrite each other. While one is in flight `value` shows the intended
 * value; a failure falls back to what is saved, and Retry sends the
 * intended value again.
 */
export function useAutoSave<V, K extends string = string>(
  write: (key: K, value: V) => Promise<unknown>
) {
  const [entries, setEntries] = useState<Partial<Record<K, Entry<V>>>>({});
  const writeRef = useRef(write);
  writeRef.current = write;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(new Map<K, number>());
  const timers = useRef(new Map<K, number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const clear = useCallback((key: K) => {
    window.clearTimeout(timers.current.get(key));
    setEntries((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const save = useCallback(
    (key: K, value: V): Promise<SaveResult> => {
      const attempt = (latest.current.get(key) ?? 0) + 1;
      latest.current.set(key, attempt);
      window.clearTimeout(timers.current.get(key));
      setEntries((current) => ({
        ...current,
        [key]: { state: "saving", value, error: current[key]?.error },
      }));
      // Only a key's newest save says how it stands.
      const isLatest = () => latest.current.get(key) === attempt;
      const result = queue.current.then(async (): Promise<SaveResult> => {
        try {
          await writeRef.current(key, value);
        } catch (error) {
          if (isLatest())
            setEntries((current) => ({
              ...current,
              [key]: { state: "failed", value, error },
            }));
          return { ok: false, error };
        }
        if (isLatest()) {
          setEntries((current) => ({
            ...current,
            [key]: { state: "saved", value },
          }));
          timers.current.set(
            key,
            window.setTimeout(() => clear(key), SAVED_NOTE_MS)
          );
        }
        return { ok: true };
      });
      queue.current = result;
      return result;
    },
    [clear]
  );

  return {
    save,
    clear,
    saving: Object.values<Entry<V> | undefined>(entries).some(
      (entry) => entry?.state === "saving"
    ),
    /** What the control shows, given what is saved. */
    value: (key: K, saved: V): V => {
      const entry = entries[key];
      return entry && entry.state !== "failed" ? entry.value : saved;
    },
    status: (key: K): SaveStatus => {
      const entry = entries[key];
      if (!entry) return IDLE;
      return {
        state: entry.state,
        error: entry.error,
        retry: () => void save(key, entry.value),
      };
    },
  };
}
