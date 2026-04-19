import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "dispatch:rewrite_localhost_pins";

function readStored(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

export function useRewriteLocalhostPins(): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(readStored);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setEnabledState(event.newValue === "true");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
    setEnabledState(value);
  }, []);

  return { enabled, setEnabled };
}
