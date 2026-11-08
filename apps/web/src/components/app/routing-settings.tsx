import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

type Mode = "off" | "shadow" | "active";
type Metrics = {
  todayReservations: number;
  retainedReservations: number;
  failures: number;
  timeouts: number;
  provider: {
    n: number;
    medianMs: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  activeRouting: { n: number; medianMs: number | null };
  estimatedUsd: number | null;
  knownEstimatedUsd: number | null;
  pricedCalls: number;
  unknownCostCalls: number;
  rates: { date: string; source: string };
};
type Status = {
  mode: Mode;
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
  dailyCap: number;
  metrics?: Metrics;
};
const endpoint = "/api/v1/experiments/routing";
const queryKey = ["routing-experiment-settings"];
const ms = (value: number | null) =>
  value === null ? "Unknown" : `${Math.round(value)} ms`;
export function RoutingSettings(): JSX.Element {
  const [key, setKey] = useState("");
  const client = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: () => api<Status>(`${endpoint}/settings`),
  });
  const check = useMutation({
    mutationFn: () =>
      api<{ status: string; result?: { latencyMs?: number } }>(
        `${endpoint}/check`,
        { method: "POST" }
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
  const save = useMutation({
    mutationFn: (body: { mode?: Mode; apiKey?: string; removeKey?: boolean }) =>
      api<Status>(`${endpoint}/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data, submitted) => {
      client.setQueryData(queryKey, data);
      if (submitted.apiKey !== undefined) {
        setKey((current) =>
          current.trim() === submitted.apiKey ? "" : current
        );
      }
      check.reset();
      void client.invalidateQueries({ queryKey });
    },
  });
  const data = settings.data;
  const metrics = data?.metrics;
  return (
    <section
      className="max-w-xl space-y-4 p-4 md:p-6"
      aria-labelledby="routing-settings-heading"
    >
      <div className="flex items-center gap-2">
        <h2 id="routing-settings-heading" className="text-sm font-semibold">
          AI routing
        </h2>
        {data?.configured && (
          <Badge title={`Key: ${data.keySource}`}>Configured</Badge>
        )}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="About AI routing"
              className="h-7 w-7"
            >
              <Info className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="max-w-[calc(100vw-2rem)] space-y-2 text-xs"
            align="start"
          >
            <p>
              Off sends nothing. Shadow records suggestions. Active chooses the
              reply location before first output; explicit routing stays
              authoritative.
            </p>
            <p>
              Bounded user and assistant excerpts go to OpenAI. No files,
              attachments, or tool output. Diagnostics contain no copied
              conversation text.
            </p>
            <p>
              Saved keys remain in server Postgres, without application-level
              encryption. Protect DB access and backups. Environment keys and
              mode override Settings. Removing a saved key leaves an environment
              key in effect.
            </p>
            <p>
              Test connection sends one synthetic request, even while Off; it
              never enables routing. Daily request caps are not dollar limits.
            </p>
            <p>
              Timing samples cover retained records (up to 14 days). Provider
              timing excludes local work; total active delay includes it. Cost
              is a standard nonregional estimate, not billing. Missing
              token/cache data is unknown.{" "}
              {metrics && (
                <>
                  Known subtotal:{" "}
                  {metrics.knownEstimatedUsd === null
                    ? "Unknown"
                    : `USD ${metrics.knownEstimatedUsd.toFixed(8)}`}{" "}
                  across {metrics.pricedCalls} priced calls;{" "}
                  {metrics.unknownCostCalls} unknown.{" "}
                  <a
                    className="underline"
                    href={metrics.rates.source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Rates: {metrics.rates.date}
                  </a>
                  .
                </>
              )}
            </p>
          </PopoverContent>
        </Popover>
      </div>
      {settings.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading…
        </p>
      )}
      {settings.error && (
        <div role="alert" className="text-xs">
          Sign in to configure.{" "}
          <a className="underline" href="/settings/security">
            Security
          </a>{" "}
          <Button size="sm" onClick={() => void settings.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {data && (
        <>
          <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3">
            <label
              htmlFor="routing-mode"
              className="text-xs text-muted-foreground"
            >
              Mode
            </label>
            <Select
              value={data.mode}
              disabled={save.isPending || data.modeSource === "environment"}
              onValueChange={(mode) => save.mutate({ mode: mode as Mode })}
            >
              <SelectTrigger
                id="routing-mode"
                className="w-full sm:w-44"
                title={
                  data.modeSource === "environment"
                    ? "Set by server environment"
                    : "Applies to new turns"
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="shadow">Shadow</SelectItem>
                <SelectItem value="active">Active</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3">
            <label
              htmlFor="routing-api-key"
              className="text-xs text-muted-foreground"
            >
              API key
            </label>
            <Input
              id="routing-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={key}
              maxLength={2048}
              onChange={(event) => setKey(event.target.value)}
              placeholder={data.configured ? "Replace key" : "Enter key"}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={save.isPending || key.trim().length < 10}
              onClick={() => save.mutate({ apiKey: key.trim() })}
            >
              Save
            </Button>
            <Button
              size="sm"
              disabled={save.isPending || !data.storedKey}
              onClick={() => save.mutate({ removeKey: true })}
            >
              Remove
            </Button>
            <Button
              size="sm"
              disabled={!data.configured || check.isPending || save.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? "Testing…" : "Test connection"}
            </Button>
          </div>
          {check.data && (
            <p role="status" className="text-xs">
              {check.data.status === "ok"
                ? `Connected${check.data.result?.latencyMs !== undefined ? ` · ${check.data.result.latencyMs} ms` : ""}`
                : `Test: ${check.data.status.replaceAll("_", " ")}`}
            </p>
          )}
          {(check.error || save.error) && (
            <p role="alert" className="text-xs text-destructive">
              {save.error ? "Save failed" : "Test unavailable"}
            </p>
          )}
          {save.isSuccess && (
            <p role="status" className="text-xs text-muted-foreground">
              Saved
            </p>
          )}
          {metrics && (
            <dl
              className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3 text-xs"
              aria-label="Routing usage summary"
            >
              <dt className="text-muted-foreground">Daily calls</dt>
              <dd>
                {metrics.todayReservations} / {data.dailyCap}
              </dd>
              <dt className="text-muted-foreground">
                Provider median / p95 / max
              </dt>
              <dd>
                {[
                  metrics.provider.medianMs,
                  metrics.provider.p95Ms,
                  metrics.provider.maxMs,
                ]
                  .map(ms)
                  .join(" / ")}{" "}
                · n={metrics.provider.n}
              </dd>
              <dt className="text-muted-foreground">Active delay · median</dt>
              <dd>
                {ms(metrics.activeRouting.medianMs)} · n=
                {metrics.activeRouting.n}
              </dd>
              <dt className="text-muted-foreground">Est. cost</dt>
              <dd>
                {metrics.estimatedUsd === null
                  ? "Unknown"
                  : `USD ${metrics.estimatedUsd.toFixed(8)}`}
              </dd>
              {metrics.failures > 0 && (
                <>
                  <dt className="text-muted-foreground">Failures / timeouts</dt>
                  <dd>
                    {metrics.failures} / {metrics.timeouts}
                  </dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
