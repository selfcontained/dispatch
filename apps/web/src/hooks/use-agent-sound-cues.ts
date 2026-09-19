import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@/components/app/types";
import { soundCuesEnabledAtom } from "@/lib/store";
import { playCueForIntent, type CueIntent } from "@/lib/sound-cues";

const INTENT_FOR_EVENT: Record<string, CueIntent | undefined> = {
  done: "done",
  blocked: "blocked",
  waiting_user: "waiting_user",
};

type Snapshot = { eventKey: string };

/**
 * Plays a sound cue when an agent transitions into one of the notable
 * terminal-ish states: done, blocked, waiting_user.
 *
 * - Subscribes to the React Query ["agents"] cache; never re-renders the host.
 * - Skips the very first observation so a snapshot/reconnect doesn't fire a
 *   wall of sound for state that already existed before the page loaded.
 */
export function useAgentSoundCues(): void {
  const enabled = useAtomValue(soundCuesEnabledAtom);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const lastByAgent = new Map<string, Snapshot>();
    let seeded = false;

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      if (!Array.isArray(key) || key[0] !== "agents") return;
      const data = event.query.state.data as Agent[] | undefined;
      if (!data) return;

      const next = new Map<string, Snapshot>();

      for (const agent of data) {
        const eventKey = agent.latestEvent
          ? `${agent.latestEvent.type}:${agent.latestEvent.updatedAt}`
          : "";
        next.set(agent.id, { eventKey });

        if (!seeded) continue;

        const prev = lastByAgent.get(agent.id);

        if (prev?.eventKey !== eventKey) {
          const intent = INTENT_FOR_EVENT[agent.latestEvent?.type ?? ""];
          if (intent) playCueForIntent(intent);
        }
      }

      lastByAgent.clear();
      for (const [k, v] of next) lastByAgent.set(k, v);
      seeded = true;
    });

    return () => unsubscribe();
  }, [enabled, queryClient]);
}
