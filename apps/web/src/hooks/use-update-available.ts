import { useEffect, useState } from "react";
import {
  getBuildVersion,
  isUpdateAvailable,
  subscribeServerVersion,
} from "@/lib/app-version";

type ReleaseStreamEvent =
  | { type: "tag"; tag: string }
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
        if (parsed.type === "tag" && typeof parsed.tag === "string") {
          const stripped = parsed.tag.replace(/^v/, "");
          setServerVersion((prev) => (prev === stripped ? prev : stripped));
        }
      } catch {
        /* ignore malformed payloads */
      }
    };
    es.onerror = () => {
      es.close();
    };
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
