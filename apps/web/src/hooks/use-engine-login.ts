import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  EngineAuthStatus,
  EngineLogin,
  EngineLoginEngine,
} from "@dispatch/shared";

import { api } from "@/lib/api";

export const ENGINE_LOGIN_LABELS: Record<EngineLoginEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function isLoginEngine(
  type: string | null | undefined
): type is EngineLoginEngine {
  return type === "claude" || type === "codex";
}

const AUTH_KEY = ["system-engines-auth"] as const;

/** Whether each engine's CLI is signed in on the server, and as whom. */
export function useEngineAuth() {
  return useQuery<{ engines: EngineAuthStatus[] }>({
    queryKey: AUTH_KEY,
    queryFn: () => api("/api/v1/system/engines/auth"),
    staleTime: 30_000,
  });
}

export function isLoginActive(login: EngineLogin | null | undefined): boolean {
  return (
    login?.status === "starting" ||
    login?.status === "waiting" ||
    login?.status === "verifying"
  );
}

export function engineLoginKey(engine: EngineLoginEngine) {
  return ["engine-login", engine] as const;
}

/**
 * The engine's sign-in as the server has it: the login under way, or the
 * one that just ended. Read from the server rather than held here, so a
 * reloaded page (or a second device) picks it up where it stands. Polled
 * while it waits on the person. `start` gets the link (joining one under
 * way), `submitCode` hands Claude its code, `cancel` gives it up.
 */
export function useEngineLogin(engine: EngineLoginEngine) {
  const queryClient = useQueryClient();
  const key = engineLoginKey(engine);
  const current = useQuery<{ login: EngineLogin | null }>({
    queryKey: key,
    queryFn: () => api(`/api/v1/system/engines/${engine}/login`),
    refetchInterval: (query) =>
      isLoginActive(query.state.data?.login) ? 1_500 : false,
  });
  const login = current.data?.login ?? null;
  const set = (data: { login: EngineLogin }) =>
    queryClient.setQueryData(key, data);
  const start = useMutation<
    { login: EngineLogin },
    Error,
    { restart?: boolean }
  >({
    mutationFn: (body) =>
      api(`/api/v1/system/engines/${engine}/login`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: set,
  });
  const submitCode = useMutation<{ login: EngineLogin }, Error, string>({
    mutationFn: (code) =>
      api(`/api/v1/system/engines/logins/${login?.id}/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    onSuccess: set,
  });
  const cancel = useMutation<{ login: EngineLogin }, Error, void>({
    mutationFn: () =>
      api(`/api/v1/system/engines/logins/${login?.id}`, { method: "DELETE" }),
    onSuccess: set,
  });
  const succeeded = login?.status === "succeeded";
  useEffect(() => {
    if (succeeded) void queryClient.invalidateQueries({ queryKey: AUTH_KEY });
  }, [succeeded, queryClient]);
  return {
    login,
    loaded: current.data !== undefined,
    error: start.error ?? submitCode.error ?? cancel.error ?? null,
    starting: start.isPending,
    submitting: submitCode.isPending,
    start: (restart = false) => {
      submitCode.reset();
      start.mutate({ restart });
    },
    submitCode: (code: string) => submitCode.mutate(code),
    cancel: () => {
      if (isLoginActive(login)) cancel.mutate();
    },
  };
}
