import { useEffect, useState } from "react";
import {
  getBuildVersion,
  isUpdateAvailable,
  subscribeServerVersion,
} from "@/lib/app-version";

type ReleaseStreamEvent =
  | { type: "deployed"; tag: string | null }
  | { type: string; [key: string]: unknown };

export type UpdateAvailableState = {
  available: boolean;
  buildVersion: string;
  serverVersion: string | null;
};

export function useUpdateAvailable(): UpdateAvailableState {
  const buildVersion = getBuildVersion();
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  useEffect(() => {
    return subscribeServerVersion((version) => {
      setServerVersion(version);
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/v1/release/stream");
    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as ReleaseStreamEvent;
        if (parsed.type === "deployed") {
          const nextVersion =
            typeof parsed.tag === "string"
              ? parsed.tag.replace(/^v/, "")
              : null;
          setServerVersion((prev) =>
            prev === nextVersion ? prev : nextVersion
          );
        }
      } catch {
        /* ignore malformed payloads */
      }
    };
    // Intentionally do not close on error — the browser's EventSource
    // reconnects automatically. Closing here would permanently silence the
    // SSE path for the life of the session after the first blip.
    return () => {
      es.close();
    };
  }, []);

  return {
    available: serverVersion ? isUpdateAvailable(serverVersion) : false,
    buildVersion,
    serverVersion,
  };
}
