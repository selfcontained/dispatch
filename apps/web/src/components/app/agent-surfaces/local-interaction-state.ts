import { useCallback, useEffect, useRef, useState } from "react";

import type {
  SurfaceInteractionRequest,
  SurfaceInteractionResponse,
} from "@/components/app/agent-surfaces/types";

/**
 * Client-only lifecycle for one action/form submission, tracked per block
 * instance (see actions-block.tsx / form-block.tsx). This is deliberately
 * *not* the server's SurfaceInteractionStatus: the POST response only ever
 * means "durably queued", never "the agent finished" — see
 * docs/agent-authored-sidebar-tabs-plan.md's Interaction contract.
 */
export type LocalInteractionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "queued"; interactionId: string; message?: string }
  | { status: "notified"; interactionId: string; message?: string }
  | { status: "error"; message: string };

export const IDLE_INTERACTION_STATE: LocalInteractionState = { status: "idle" };

/** Narrow view of `useSubmitSurfaceInteraction(...).mutate` that the hooks
 * below need — kept separate from react-query's own types so this module
 * doesn't have to import react-query just to describe the shape it calls. */
export type SubmitInteractionFn = (
  request: SurfaceInteractionRequest,
  handlers: {
    onSuccess: (response: SurfaceInteractionResponse) => void;
    onError: (error: Error) => void;
  }
) => void;

/**
 * Maps a successful interaction POST response to the local UI state.
 *
 * Keys off `response.delivery`, not `interaction.status`: the server sets
 * `delivery` specifically to answer "queued or already seen by the agent",
 * and it stays authoritative for an idempotent replay where the stored
 * interaction has since moved past "notified" (e.g. `completed`/`rejected`)
 * — `interaction.status` alone would misreport that already-resolved case
 * as still-queued. See SurfacesService#submitInteraction.
 *
 * `interactionId` is carried through so `resolveInteractionPresentation` can
 * tell this submission apart from an older durable summary for the same
 * (blockId, actionId) that the surface payload has not refetched past yet.
 * Interaction changes do not bump the surface revision, so the id — not the
 * revision — is what settles which of the two sources is fresher.
 */
export function interactionStateFromResponse(
  response: SurfaceInteractionResponse
): LocalInteractionState {
  return {
    status: response.delivery === "notified" ? "notified" : "queued",
    interactionId: response.interaction.id,
    message: response.interaction.outcomeMessage,
  };
}

/** Maps a failed interaction POST to the local UI state. */
export function interactionStateFromError(
  error: Error,
  fallbackMessage: string
): LocalInteractionState {
  return {
    status: "error",
    message: error.message || fallbackMessage,
  };
}

/**
 * Resets local interaction state whenever the surface document's revision
 * moves forward — a bump implies the agent (or another user action) moved
 * the document forward, most likely resolving whatever was pending locally.
 * Shared by actions-block.tsx (keyed) and form-block.tsx (single) so the
 * "what counts as stale" rule can't drift between the two.
 */
export function useResetOnRevisionChange(
  surfaceRevision: number,
  onReset: () => void
): void {
  const lastRevisionRef = useRef(surfaceRevision);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;

  useEffect(() => {
    if (surfaceRevision !== lastRevisionRef.current) {
      lastRevisionRef.current = surfaceRevision;
      onResetRef.current();
    }
  }, [surfaceRevision]);
}

/**
 * Single-slot interaction lifecycle for a form block: one submit state for
 * the whole block, reset to idle on a revision bump. `mutate` is bound once
 * at construction (mirroring `useKeyedInteractionState`) rather than passed
 * on every `submit` call — it comes from `useSubmitSurfaceInteraction`,
 * which is stable across renders.
 */
export function useSingleInteractionState(
  surfaceRevision: number,
  mutate: SubmitInteractionFn
): {
  state: LocalInteractionState;
  reset: () => void;
  submit: (
    request: SurfaceInteractionRequest,
    fallbackMessage: string,
    onSuccess?: (response: SurfaceInteractionResponse) => void
  ) => void;
} {
  const [state, setState] = useState<LocalInteractionState>(
    IDLE_INTERACTION_STATE
  );
  const reset = useCallback(() => setState(IDLE_INTERACTION_STATE), []);
  useResetOnRevisionChange(surfaceRevision, reset);

  const submit = useCallback(
    (
      request: SurfaceInteractionRequest,
      fallbackMessage: string,
      onSuccess?: (response: SurfaceInteractionResponse) => void
    ) => {
      setState({ status: "submitting" });
      mutate(request, {
        onSuccess: (response) => {
          onSuccess?.(response);
          setState(interactionStateFromResponse(response));
        },
        onError: (error) =>
          setState(interactionStateFromError(error, fallbackMessage)),
      });
    },
    [mutate]
  );

  return { state, reset, submit };
}

/**
 * Keyed interaction lifecycle for an actions block: independent state per
 * action id, all reset together on a revision bump. `mutate` is bound once
 * at construction, symmetric with `useSingleInteractionState`.
 */
export function useKeyedInteractionState(
  surfaceRevision: number,
  mutate: SubmitInteractionFn
): {
  states: Record<string, LocalInteractionState>;
  submit: (
    key: string,
    request: SurfaceInteractionRequest,
    fallbackMessage: string
  ) => void;
  clear: (key: string) => void;
} {
  const [states, setStates] = useState<Record<string, LocalInteractionState>>(
    {}
  );
  useResetOnRevisionChange(surfaceRevision, () => setStates({}));

  const submit = useCallback(
    (
      key: string,
      request: SurfaceInteractionRequest,
      fallbackMessage: string
    ) => {
      setStates((prev) => ({ ...prev, [key]: { status: "submitting" } }));
      mutate(request, {
        onSuccess: (response) => {
          setStates((prev) => ({
            ...prev,
            [key]: interactionStateFromResponse(response),
          }));
        },
        onError: (error) => {
          setStates((prev) => ({
            ...prev,
            [key]: interactionStateFromError(error, fallbackMessage),
          }));
        },
      });
    },
    [mutate]
  );

  const clear = useCallback((key: string) => {
    setStates((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return { states, submit, clear };
}
