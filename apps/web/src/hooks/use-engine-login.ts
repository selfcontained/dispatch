import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  EngineAuthStatus,
  EngineLogin,
  EngineLoginEngine,
} from "@dispatch/shared";
import type {
  EngineOperation,
  EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";

import { api } from "@/lib/api";
import { runnerEnginesKey } from "@/hooks/use-runner-engines";

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

async function runnerLoginRequest(
  runnerId: string,
  engine: EngineLoginEngine,
  operation:
    | Extract<EngineOperation, { type: `login_${string}` }>
    | { type: "login_status"; engine: EngineLoginEngine }
): Promise<{ login: EngineLogin | null }> {
  const { ack } = await api<{ ack: EngineOperationAck }>(
    "/api/v1/engine-management/operations",
    {
      method: "POST",
      body: JSON.stringify({ scope: { kind: "runner", runnerId }, operation }),
    }
  );
  if (!ack.ok) throw new Error(ack.error);
  if (!ack.login) return { login: null };
  if (ack.login.engine !== engine || ack.login.expiresAt === undefined) {
    throw new Error("The runner did not return the requested sign-in.");
  }
  return { login: { ...ack.login, engine, expiresAt: ack.login.expiresAt } };
}

/**
 * The engine's sign-in as the server has it: the login under way, or the
 * one that just ended. Read from the server rather than held here, so a
 * reloaded page (or a second device) picks it up where it stands. Polled
 * while it waits on the person. `start` gets the link (joining one under
 * way), `submitCode` hands Claude its code, `cancel` gives it up.
 */
export function useEngineLogin(engine: EngineLoginEngine, runnerId?: string) {
  const queryClient = useQueryClient();
  const key = runnerId
    ? [...engineLoginKey(engine), runnerId]
    : engineLoginKey(engine);
  const current = useQuery<{ login: EngineLogin | null }>({
    queryKey: key,
    ...(runnerId ? { retry: false } : {}),
    queryFn: () =>
      runnerId
        ? runnerLoginRequest(runnerId, engine, { type: "login_status", engine })
        : api(`/api/v1/system/engines/${engine}/login`),
    refetchInterval: (query) =>
      isLoginActive(query.state.data?.login) ? 1_500 : false,
  });
  const login = current.data?.login ?? null;
  const set = async (data: { login: EngineLogin | null }) => {
    if (runnerId)
      await queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.setQueryData(key, data);
  };
  const start = useMutation<
    { login: EngineLogin | null },
    Error,
    { restart?: boolean }
  >({
    mutationFn: (body) =>
      runnerId
        ? runnerLoginRequest(runnerId, engine, {
            type: "login_start",
            engine,
            ...body,
          })
        : api(`/api/v1/system/engines/${engine}/login`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
    onSuccess: set,
  });
  const submitCode = useMutation<
    { login: EngineLogin | null },
    Error,
    { loginId: string; code: string }
  >({
    mutationFn: ({ loginId, code }) =>
      runnerId
        ? runnerLoginRequest(runnerId, engine, {
            type: "login_submit",
            loginId,
            code,
          })
        : api(`/api/v1/system/engines/logins/${loginId}/code`, {
            method: "POST",
            body: JSON.stringify({ code }),
          }),
    onSuccess: set,
  });
  const cancel = useMutation<{ login: EngineLogin | null }, Error, string>({
    mutationFn: (loginId) =>
      runnerId
        ? runnerLoginRequest(runnerId, engine, {
            type: "login_cancel",
            loginId,
          })
        : api(`/api/v1/system/engines/logins/${loginId}`, { method: "DELETE" }),
    onSuccess: set,
  });
  const succeeded = login?.status === "succeeded";
  useEffect(() => {
    if (succeeded) {
      const queryKey = runnerId
        ? runnerEnginesKey({ kind: "runner", runnerId })
        : AUTH_KEY;
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [succeeded, queryClient, runnerId]);
  return {
    login,
    loaded: current.data !== undefined || (!!runnerId && current.isError),
    error: start.error ?? submitCode.error ?? cancel.error ?? null,
    starting: start.isPending,
    submitting: submitCode.isPending,
    start: (restart = false) => {
      submitCode.reset();
      start.mutate({ restart });
    },
    submitCode: (code: string) => {
      if (login) submitCode.mutate({ loginId: login.id, code });
    },
    cancel: () => {
      if (login && isLoginActive(login)) cancel.mutate(login.id);
    },
  };
}
