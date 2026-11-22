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
import { Switch } from "@/components/ui/switch";
import { IconButton } from "@/components/ui/icon-button";
import { Hint } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Panel } from "@/components/ui/card";
import { useAutoSave } from "@/hooks/use-auto-save";
import { Alert } from "@/components/ui/alert";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { SaveFailure, SettingRow } from "@/components/ui/setting-row";

type Status = {
  aiEnabled?: boolean;
  routingPreference?: "off" | "active";
  mode: "off" | "shadow" | "active";
  steeringPreference?: "off" | "active";
  mergeRiskPreference?: "off" | "active";
  sessionNamingPreference?: "off" | "active";
  sessionNamingMode?: "off" | "active";
  steeringMode: "off" | "active";
  mergeRiskMode?: "off" | "active";
  modeSource: string;
  configured: boolean;
  keySource: string;
  storedKey: boolean;
};
const endpoint = "/api/v1/experiments/routing";
const queryKey = ["routing-experiment-settings"];
type Toggle =
  | "aiEnabled"
  | "mode"
  | "steeringMode"
  | "sessionNamingMode"
  | "mergeRiskMode";

export function RoutingSettings(): JSX.Element {
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [validatedAndSaved, setValidatedAndSaved] = useState(false);
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
    mutationFn: (body: { apiKey?: string; removeKey?: boolean }) =>
      api<Status>(`${endpoint}/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (data, submitted) => {
      client.setQueryData(queryKey, data);
      if (submitted.apiKey !== undefined || submitted.removeKey)
        setValidatedAndSaved(
          submitted.apiKey !== undefined && !submitted.removeKey
        );
      if (submitted.apiKey !== undefined)
        setKey((current) =>
          current.trim() === submitted.apiKey ? "" : current
        );
      if (submitted.apiKey !== undefined || submitted.removeKey)
        setEditing(false);
      check.reset();
    },
  });
  // Apart from the key's mutation, whose state is the key editor's.
  const autoSave = useAutoSave<boolean, Toggle>(async (name, on) => {
    const saved = await api<Status>(`${endpoint}/settings`, {
      method: "PUT",
      body: JSON.stringify(
        name === "aiEnabled"
          ? { aiEnabled: on }
          : { [name]: on ? "active" : "off" }
      ),
    });
    client.setQueryData(queryKey, saved);
    check.reset();
  });
  const data = settings.data;
  const aiOn = autoSave.value(
    "aiEnabled",
    Boolean(data && (data.aiEnabled ?? data.configured))
  );
  const editToken = editing || data?.configured === false;
  const testOk = check.data?.status === "ok" || validatedAndSaved;
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
    <SettingsGroup title="Dispatch AI">
      {settings.isPending && (
        <LoadingSkeleton label="Loading routing settings…" />
      )}
      {settings.error && (
        <LoadError
          thing="routing settings"
          error={settings.error}
          retrying={settings.isFetching}
          onRetry={() => void settings.refetch()}
        />
      )}
      {data && (
        <SettingRow
          label="Enable Dispatch AI"
          status={autoSave.status("aiEnabled")}
        >
          <Switch
            aria-label="Enable Dispatch AI"
            checked={aiOn}
            disabled={save.isPending || check.isPending}
            onCheckedChange={(on) => void autoSave.save("aiEnabled", on)}
          />
        </SettingRow>
      )}
      {data && !aiOn && data.configured && (
        <SettingRow
          layout="action"
          label="OpenAI API key saved"
          description="AI features are off. Your saved key is retained."
        >
          <Button
            size="sm"
            variant="ghost"
            aria-label="Remove OpenAI API key"
            disabled={save.isPending || check.isPending}
            onClick={() => save.mutate({ removeKey: true })}
          >
            <Trash2 />
            Remove key
          </Button>
        </SettingRow>
      )}
      {data && aiOn && (
        <div className="space-y-2">
          <p className="text-body-sm text-muted-foreground">
            Dispatch AI requires an OpenAI API key. Create a key in your OpenAI
            project, then validate and save it here. API usage can incur OpenAI
            charges, separate from a ChatGPT subscription.
          </p>
          <Panel className="space-y-4">
            <div className="flex h-8 items-center justify-between gap-3">
              <label
                htmlFor="routing-key"
                className="flex items-center gap-1.5 text-body-sm font-medium"
              >
                OpenAI API key
                <Hint
                  label={
                    check.isPending ||
                    check.data ||
                    check.error ||
                    validatedAndSaved
                      ? testLabel
                      : data.configured
                        ? "API key set"
                        : "No key set"
                  }
                >
                  <span className="flex h-4 w-4 items-center justify-center">
                    {data.configured && (
                      <TestIcon
                        className={`h-3 w-3 transition-colors ${check.isPending ? "animate-spin text-muted-foreground" : testOk ? "text-success-ink" : testFailed ? "text-danger" : "text-muted-foreground"}`}
                        aria-label={
                          check.isPending ||
                          check.data ||
                          check.error ||
                          validatedAndSaved
                            ? testLabel
                            : "API key set"
                        }
                      />
                    )}
                  </span>
                </Hint>
              </label>
              {!editToken && (
                <Button
                  size="sm"
                  className="min-w-12 text-body-sm"
                  aria-label="Test connection"
                  disabled={
                    (editToken ? key.trim().length < 10 : !data.configured) ||
                    check.isPending ||
                    save.isPending
                  }
                  onClick={() => {
                    setValidatedAndSaved(false);
                    check.mutate(undefined);
                  }}
                >
                  Test
                </Button>
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              {editToken ? (
                <Input
                  id="routing-key"
                  type="password"
                  aria-label="OpenAI API key"
                  className="min-w-0"
                  aria-invalid={Boolean(save.error) || undefined}
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
                  placeholder="Enter key"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      save.reset();
                      check.reset();
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
                  id="routing-key"
                  className="min-w-0 cursor-default text-muted-foreground"
                  aria-label="OpenAI API key is set"
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
                      className="text-body-sm"
                      pending={save.isPending}
                      disabled={check.isPending || key.trim().length < 10}
                      onClick={() => save.mutate({ apiKey: key.trim() })}
                    >
                      Validate & save
                    </Button>
                    {data.configured && (
                      <IconButton
                        tooltip="Cancel"
                        label="Cancel key edit"
                        disabled={
                          save.isPending || check.isPending || !data.configured
                        }
                        onClick={() => {
                          check.reset();
                          setKey("");
                          setEditing(false);
                          save.reset();
                        }}
                      >
                        <X />
                      </IconButton>
                    )}
                  </>
                ) : (
                  <>
                    <IconButton
                      tooltip="Edit key"
                      label="Edit OpenAI API key"
                      disabled={save.isPending || check.isPending}
                      onClick={() => {
                        setValidatedAndSaved(false);
                        setEditing(true);
                        check.reset();
                      }}
                    >
                      <Pencil />
                    </IconButton>
                    <IconButton
                      tooltip="Remove key and turn off Dispatch AI features"
                      className="hover:text-danger"
                      label="Remove OpenAI API key"
                      disabled={save.isPending || check.isPending}
                      onClick={() => save.mutate({ removeKey: true })}
                    >
                      <Trash2 />
                    </IconButton>
                  </>
                )}
              </div>
            </div>
            <p className="text-body-sm text-muted-foreground">
              {editToken
                ? "Validate & save checks the entered key before replacing the saved key."
                : "Test checks the saved key."}
            </p>
            {validatedAndSaved && (
              <p role="status" className="text-body-sm text-success-ink">
                OpenAI API key validated and saved.
              </p>
            )}
            {check.data?.message && (
              <p
                role={testFailed ? "alert" : "status"}
                className="text-body-sm"
              >
                {check.data.message}
              </p>
            )}
            {check.error && (
              <Alert title="Couldn’t test the key." error={check.error} />
            )}
            <span className="sr-only" role="status">
              {check.isPending || check.data || check.error || validatedAndSaved
                ? testLabel
                : ""}
            </span>
          </Panel>
          <SettingRow
            label="Route replies automatically"
            description={
              data.configured
                ? "Choose the main conversation or a side thread."
                : "Add an OpenAI API key to enable routing."
            }
            disabled={!data.configured}
            status={autoSave.status("mode")}
          >
            <Switch
              aria-label="Route replies automatically"
              checked={
                data.configured &&
                autoSave.value(
                  "mode",
                  (data.routingPreference ?? data.mode) === "active"
                )
              }
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) => void autoSave.save("mode", on)}
            />
          </SettingRow>
          <SettingRow
            label="Smart steering"
            description={
              data.configured
                ? "Steer related messages. Queue new requests."
                : "Add an OpenAI API key to enable steering."
            }
            disabled={!data.configured}
            status={autoSave.status("steeringMode")}
          >
            <Switch
              aria-label="Smart steering"
              checked={
                data.configured &&
                autoSave.value(
                  "steeringMode",
                  (data.steeringPreference ?? data.steeringMode) === "active"
                )
              }
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) => void autoSave.save("steeringMode", on)}
            />
          </SettingRow>
          <SettingRow
            label="Session naming"
            description={
              data.configured
                ? "Send launch text, links, and document excerpts to OpenAI for a topic name."
                : "Add an OpenAI API key to enable session naming."
            }
            disabled={!data.configured}
            status={autoSave.status("sessionNamingMode")}
          >
            <Switch
              aria-label="Session naming"
              checked={
                data.configured &&
                autoSave.value(
                  "sessionNamingMode",
                  (data.sessionNamingPreference ?? data.sessionNamingMode) ===
                    "active"
                )
              }
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) =>
                void autoSave.save("sessionNamingMode", on)
              }
            />
          </SettingRow>
          <SettingRow
            label="Merge risk assessment"
            description={
              data.configured
                ? "Recommend a human read before merge. Never merges."
                : "Add an OpenAI API key to enable merge risk."
            }
            disabled={!data.configured}
            status={autoSave.status("mergeRiskMode")}
          >
            <Switch
              aria-label="Merge risk assessment"
              checked={
                data.configured &&
                autoSave.value(
                  "mergeRiskMode",
                  (data.mergeRiskPreference ?? data.mergeRiskMode) === "active"
                )
              }
              disabled={save.isPending || check.isPending || !data.configured}
              onCheckedChange={(on) => void autoSave.save("mergeRiskMode", on)}
            />
          </SettingRow>
        </div>
      )}
      {save.error && (
        <SaveFailure
          status={{
            state: "failed",
            error: save.error,
            // A rejected key is edited and saved again; a removal can repeat.
            retry: save.variables?.removeKey
              ? () => save.mutate({ removeKey: true })
              : undefined,
          }}
        />
      )}
    </SettingsGroup>
  );
}
