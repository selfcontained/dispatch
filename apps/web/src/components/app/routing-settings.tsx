import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  Pencil,
  Trash2,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";

type Status = {
  mode: "off" | "shadow" | "active";
  steeringMode: "off" | "active";
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
};
const endpoint = "/api/v1/experiments/routing";
const queryKey = ["routing-experiment-settings"];
export function RoutingSettings(): JSX.Element {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const client = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: () => api<Status>(`${endpoint}/settings`),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const check = useMutation({
    mutationFn: (apiKey?: string) =>
      api<{ status: string; message?: string }>(`${endpoint}/check`, {
        method: "POST",
        body: JSON.stringify(apiKey === undefined ? {} : { apiKey }),
      }),
  });
  const save = useMutation({
    mutationFn: (body: {
      mode?: "off" | "active";
      steeringMode?: "off" | "active";
      apiKey?: string;
      removeKey?: boolean;
    }) =>
      api<Status>(`${endpoint}/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data, submitted) => {
      client.setQueryData(queryKey, data);
      if (submitted.apiKey !== undefined)
        setKey((current) =>
          current.trim() === submitted.apiKey ? "" : current
        );
      if (submitted.apiKey !== undefined || submitted.removeKey)
        setEditing(false);
      check.reset();
    },
  });
  const data = settings.data;
  const editToken = editing || data?.configured === false;
  const testOk = check.data?.status === "ok";
  const testFailed = !!check.error || (!!check.data && !testOk);
  const testLabel = check.isPending
    ? "Testing connection"
    : testOk
      ? "Connection successful"
      : testFailed
        ? "Connection failed — test again"
        : "Test connection";
  const TestIcon = check.isPending
    ? Loader2
    : testOk
      ? CheckCircle2
      : testFailed
        ? XCircle
        : CheckCircle2;
  return (
    <section
      className="max-w-xl space-y-4 p-4 md:p-6"
      aria-labelledby="routing-settings-heading"
    >
      <div>
        <h2 id="routing-settings-heading" className="text-sm font-semibold">
          AI routing
        </h2>
      </div>
      {settings.isPending && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {settings.error && (
        <p role="alert" className="text-xs text-destructive">
          Couldn’t load routing settings.{" "}
          <button className="underline" onClick={() => void settings.refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && (
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
            <Checkbox
              id="routing-enabled"
              aria-label="Route replies automatically"
              checked={data.configured && data.mode === "active"}
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) =>
                save.mutate({ mode: on === true ? "active" : "off" })
              }
            />
            <div className="min-w-0">
              <div className="text-sm font-medium">
                Route replies automatically
              </div>
              <p className="text-xs text-muted-foreground">
                {data.configured
                  ? "Choose the main conversation or a side thread."
                  : "Add an access token to enable routing."}
              </p>
            </div>
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
            <Checkbox
              aria-label="Smart steering"
              checked={data.configured && data.steeringMode === "active"}
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) =>
                save.mutate({ steeringMode: on === true ? "active" : "off" })
              }
            />
            <div className="min-w-0">
              <div className="text-sm font-medium">Smart steering</div>
              <p className="text-xs text-muted-foreground">
                {data.configured
                  ? "Steer related messages. Queue new requests."
                  : "Add an access token to enable steering."}
              </p>
            </div>
          </label>
          <div className="space-y-4 rounded border border-border px-3 py-3">
            <div className="flex h-8 items-center justify-between gap-3">
              <label
                htmlFor="routing-token"
                className="flex items-center gap-1.5 text-xs font-medium"
              >
                Access token
                <span
                  className="flex h-4 w-4 items-center justify-center"
                  title={
                    check.isPending || check.data || check.error
                      ? testLabel
                      : data.configured
                        ? "Token set"
                        : "No token set"
                  }
                >
                  {data.configured && (
                    <TestIcon
                      className={`h-3 w-3 transition-colors ${check.isPending ? "animate-spin text-muted-foreground" : testOk ? "text-green-600 dark:text-green-400" : testFailed ? "text-destructive" : "text-muted-foreground"}`}
                      aria-label={
                        check.isPending || check.data || check.error
                          ? testLabel
                          : "Token set"
                      }
                    />
                  )}
                </span>
              </label>
              <Button
                size="sm"
                className="h-8 min-w-12 px-3 text-xs"
                aria-label="Test connection"
                disabled={
                  (editToken ? key.trim().length < 10 : !data.configured) ||
                  check.isPending ||
                  save.isPending
                }
                onClick={() => check.mutate(editToken ? key.trim() : undefined)}
              >
                Test
              </Button>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] sm:grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-2">
              {editToken ? (
                <Input
                  id="routing-token"
                  type="password"
                  aria-label="Access token"
                  className={`h-11 sm:h-9 min-w-0 ${save.error ? "ring-1 ring-destructive" : ""}`}
                  value={key}
                  disabled={save.isPending || check.isPending}
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={2048}
                  onChange={(e) => {
                    setKey(e.target.value);
                    check.reset();
                    save.reset();
                  }}
                  placeholder="Enter token"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setEditing(false);
                      setKey("");
                    }
                    if (
                      e.key === "Enter" &&
                      key.trim().length >= 10 &&
                      !save.isPending &&
                      !check.isPending
                    )
                      save.mutate({ apiKey: key.trim() });
                  }}
                />
              ) : (
                <Input
                  id="routing-token"
                  className="h-11 sm:h-9 min-w-0 cursor-default text-muted-foreground"
                  aria-label="Access token is set"
                  value="••••••••••••••••"
                  readOnly
                />
              )}
              <div
                className={`flex h-11 sm:h-9 items-center ${editToken ? "justify-end gap-1" : "justify-between"}`}
              >
                {editToken ? (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      className="h-8 w-16 px-2"
                      disabled={
                        save.isPending ||
                        check.isPending ||
                        key.trim().length < 10
                      }
                      onClick={() => save.mutate({ apiKey: key.trim() })}
                    >
                      {save.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Save"
                      )}
                    </Button>
                    {data.configured && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        aria-label="Cancel token edit"
                        title="Cancel"
                        disabled={
                          save.isPending || check.isPending || !data.configured
                        }
                        onClick={() => {
                          setKey("");
                          setEditing(false);
                          save.reset();
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-11 w-11 sm:h-8 sm:w-8 shrink-0"
                      aria-label="Edit access token"
                      title="Edit token"
                      disabled={save.isPending || check.isPending}
                      onClick={() => {
                        setEditing(true);
                        check.reset();
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-11 w-11 sm:h-8 sm:w-8 shrink-0 hover:text-destructive"
                      aria-label="Remove access token"
                      title="Remove token and turn off routing and steering"
                      disabled={save.isPending || check.isPending}
                      onClick={() =>
                        save.mutate({ removeKey: true, mode: "off" })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {editToken
                ? "Test checks the entered token. Save validates it again before replacing the saved token."
                : "Test checks the saved token."}
            </p>
            {check.data?.message && (
              <p role={testFailed ? "alert" : "status"} className="text-xs">
                {check.data.message}
              </p>
            )}
            {check.error && (
              <p role="alert" className="text-xs text-destructive">
                {check.error.message}
              </p>
            )}
            <span className="sr-only" role="status">
              {check.isPending || check.data || check.error ? testLabel : ""}
            </span>
          </div>
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-xs text-destructive">
          Couldn’t save changes. {save.error.message}
        </p>
      )}
    </section>
  );
}
