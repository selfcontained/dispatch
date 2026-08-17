import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

type PeerSelf = {
  instanceId: string;
  /** What peers adopt as their label for this instance when they pair. */
  name: string;
  passwordSet: boolean;
  tailscale: { dnsName: string; stableId: string } | null;
  bind: {
    enabled: boolean;
    active: boolean;
    address: string | null;
    blockedReason:
      | "no-password"
      | "no-tailscale"
      | "wildcard-host"
      | null;
  };
};

type Capabilities = {
  allowLaunch: boolean;
  allowMessage: boolean;
  allowFullAccess: boolean;
};

type Peer = Capabilities & {
  id: string;
  name: string;
  reportedName: string | null;
  url: string;
  tailnetStableId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

type PairingOffer = {
  pairingId: string;
  code: string;
  expiresAt: string;
  address: string | null;
};

const DEFAULT_CAPABILITIES: Capabilities = {
  allowLaunch: true,
  allowMessage: true,
  allowFullAccess: false,
};

const CAPABILITY_LABELS: {
  key: keyof Capabilities;
  label: string;
  hint: string;
}[] = [
  {
    key: "allowLaunch",
    label: "Launch agents here",
    hint: "Start new agents on this machine.",
  },
  {
    key: "allowMessage",
    label: "Message agents here",
    hint: "Send prompts to agents already running on this machine.",
  },
  {
    key: "allowFullAccess",
    label: "Allow full access",
    hint: "Let launched agents run with the sandbox off.",
  },
];

/** The three switches shown on both the accept and connect cards. */
function CapabilitySwitches({
  value,
  onChange,
  idPrefix,
}: {
  value: Capabilities;
  onChange: (next: Capabilities) => void;
  idPrefix: string;
}): JSX.Element {
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">What the other instance may do here</p>
      {CAPABILITY_LABELS.map(({ key, label, hint }) => (
        <div key={key} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <label
              htmlFor={`${idPrefix}-${key}`}
              className="text-sm font-medium"
            >
              {label}
            </label>
            <p className="text-sm text-muted-foreground">{hint}</p>
          </div>
          <Switch
            id={`${idPrefix}-${key}`}
            checked={value[key]}
            onCheckedChange={(checked) =>
              onChange({ ...value, [key]: checked })
            }
            aria-label={label}
          />
        </div>
      ))}
    </div>
  );
}

const selfQueryKey = ["peers", "self"] as const;
const peersQueryKey = ["peers", "list"] as const;

export function LinkedInstancesSettings(): JSX.Element {
  const queryClient = useQueryClient();
  const selfQuery = useQuery({
    queryKey: selfQueryKey,
    queryFn: () => api<PeerSelf>("/api/v1/peers/self"),
  });
  const peersQuery = useQuery({
    queryKey: peersQueryKey,
    queryFn: async () => (await api<{ peers: Peer[] }>("/api/v1/peers")).peers,
  });

  const bindMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api("/api/v1/peers/settings/tailnet-bind", {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: selfQueryKey }),
  });

  const [offerCaps, setOfferCaps] = useState<Capabilities>(
    DEFAULT_CAPABILITIES
  );
  const offerMutation = useMutation({
    mutationFn: () =>
      api<PairingOffer>("/api/v1/peers/pairings", {
        method: "POST",
        body: JSON.stringify({ ...offerCaps, requireTailnet: true }),
      }),
  });

  const [linkAddress, setLinkAddress] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [linkName, setLinkName] = useState("");
  const [linkCaps, setLinkCaps] = useState<Capabilities>(DEFAULT_CAPABILITIES);
  const linkMutation = useMutation({
    mutationFn: () =>
      api<{ peer: Peer }>("/api/v1/peers/link", {
        method: "POST",
        body: JSON.stringify({
          address: linkAddress.trim(),
          code: linkCode.trim(),
          ...(linkName.trim() ? { name: linkName.trim() } : {}),
          ...linkCaps,
        }),
      }),
    onSuccess: () => {
      setLinkAddress("");
      setLinkCode("");
      setLinkName("");
      void queryClient.invalidateQueries({ queryKey: peersQueryKey });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (peerId: string) =>
      api(`/api/v1/peers/${peerId}`, { method: "DELETE" }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: peersQueryKey }),
  });

  // Local label only — the remote is never told. "Cloud" describes where the
  // peer sits relative to THIS machine.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api(`/api/v1/peers/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setRenamingId(null);
      void queryClient.invalidateQueries({ queryKey: peersQueryKey });
    },
  });

  const [selfNameDraft, setSelfNameDraft] = useState<string | null>(null);
  const selfNameMutation = useMutation({
    mutationFn: (instanceName: string) =>
      api("/api/v1/agents/settings", {
        method: "POST",
        body: JSON.stringify({ instanceName }),
      }),
    onSuccess: () => {
      setSelfNameDraft(null);
      void queryClient.invalidateQueries({ queryKey: selfQueryKey });
    },
  });

  const self = selfQuery.data;
  const peers = peersQuery.data ?? [];
  const offer = offerMutation.data;

  return (
    <div className="space-y-6" data-testid="linked-instances-settings">
      <div>
        <h2 className="text-xl font-semibold">Linked instances</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Pair this Dispatch with another one you own — then agents can be
          launched there by adding a location to the same launch tools. While
          the instances can't reach each other (laptop closed, VPN down),
          messages queue and deliver on reconnect; remote agent status shows the
          last known state until then.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">This instance</CardTitle>
          {self && (
            <CardDescription>
              {self.tailscale
                ? `On the tailnet as ${self.tailscale.dnsName}`
                : "Tailscale not detected — linking needs both machines on one tailnet."}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="self-name" className="text-sm font-medium">
              Name
            </label>
            <p className="text-sm text-muted-foreground">
              What other instances will call this one when they link to it, and
              what agents there pass as the launch location. Something
              positional reads best — "Cloud", "Studio", "Laptop".
            </p>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (selfNameDraft !== null) {
                  selfNameMutation.mutate(selfNameDraft.trim());
                }
              }}
            >
              <Input
                id="self-name"
                value={selfNameDraft ?? self?.name ?? ""}
                onChange={(e) => setSelfNameDraft(e.target.value)}
                placeholder="Cloud"
                className="sm:flex-1"
              />
              <Button
                type="submit"
                variant="default"
                disabled={
                  selfNameMutation.isPending ||
                  selfNameDraft === null ||
                  selfNameDraft.trim().length === 0 ||
                  selfNameDraft.trim() === self?.name
                }
              >
                Save
              </Button>
            </form>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Accept tailnet connections</p>
              <p className="text-sm text-muted-foreground">
                Expose the API on the tailnet interface so linked instances can
                reach this one.
              </p>
            </div>
            <Switch
              checked={self?.bind.enabled ?? false}
              disabled={!self || bindMutation.isPending}
              onCheckedChange={(enabled) => bindMutation.mutate(enabled)}
              aria-label="Accept tailnet connections"
            />
          </div>
          {bindMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(bindMutation.error as Error).message}
            </p>
          )}
          {self?.bind.enabled && self.bind.blockedReason === "no-password" && (
            <p className="text-sm text-destructive" role="alert">
              Blocked: set a password first — without one every route is open.
            </p>
          )}
          {self?.bind.enabled && self.bind.blockedReason === "no-tailscale" && (
            <p className="text-sm text-destructive" role="alert">
              Blocked: tailscale is not running on this machine.
            </p>
          )}
          {/* Not a failure: the server binds all interfaces, so the tailnet is
              already served and a second listener would collide on the port. */}
          {self?.bind.enabled && self.bind.blockedReason === "wildcard-host" && (
            <p className="text-sm text-muted-foreground">
              Already reachable on the tailnet — this server binds all
              interfaces, so no separate listener is needed.
            </p>
          )}
          {self?.bind.active && self.bind.address && (
            <p className="text-sm text-muted-foreground">
              Listening on {self.bind.address}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Accept a connection from another instance
          </CardTitle>
          <CardDescription>
            Do this on the machine being connected TO (e.g. the cloud box). It
            shows a code; you enter that code on the other machine below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {offer ? (
            <div className="rounded-md border p-4 text-center">
              <p className="font-mono text-3xl tracking-[0.3em]">
                {offer.code}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                On the OTHER instance, open Settings → Connections and enter{" "}
                <span className="font-mono">
                  {offer.address ?? "this instance's address"}
                </span>{" "}
                plus this code into its "Connect to another instance" form.
                Expires in 10 minutes.
              </p>
            </div>
          ) : (
            <>
              <CapabilitySwitches
                value={offerCaps}
                onChange={setOfferCaps}
                idPrefix="offer"
              />
              <Button
                variant="default"
                disabled={offerMutation.isPending || !self?.passwordSet}
                onClick={() => offerMutation.mutate()}
              >
                <MonitorSmartphone className="mr-2 h-4 w-4" />
                Show pairing code
              </Button>
            </>
          )}
          {self && !self.passwordSet && (
            <p className="text-sm text-destructive" role="alert">
              Pairing requires a password — set one in Settings → Security
              first, on both instances.
            </p>
          )}
          {offerMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(offerMutation.error as Error).message}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Connect to another instance
          </CardTitle>
          <CardDescription>
            Do this on the machine you're connecting FROM (e.g. your laptop),
            using the address and code the other instance is showing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              linkMutation.mutate();
            }}
          >
            <Input
              value={linkAddress}
              onChange={(e) => setLinkAddress(e.target.value)}
              placeholder="other-host.tailnet.ts.net:6767"
              aria-label="Instance address"
              className="sm:flex-1"
            />
            <Input
              value={linkCode}
              onChange={(e) => setLinkCode(e.target.value)}
              placeholder="Code"
              aria-label="Pairing code"
              className="sm:w-28"
            />
            <Input
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              placeholder="Call it…"
              aria-label="Name for this instance"
              className="sm:w-36"
            />
            <Button
              type="submit"
              disabled={
                linkMutation.isPending ||
                linkAddress.trim().length === 0 ||
                linkCode.trim().length < 6
              }
            >
              {linkMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Link
            </Button>
          </form>
          <p className="text-sm text-muted-foreground">
            The name is yours alone — it's what agents here pass as the launch
            location, and the other instance is never told. Leave it blank to
            use whatever that instance calls itself.
          </p>
          <CapabilitySwitches
            value={linkCaps}
            onChange={setLinkCaps}
            idPrefix="link"
          />
          {self && !self.passwordSet && (
            <p className="text-sm text-destructive" role="alert">
              Pairing requires a password — set one in Settings → Security
              first, on both instances.
            </p>
          )}
          {linkMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(linkMutation.error as Error).message}
            </p>
          )}
        </CardContent>
      </Card>

      {(peers.length > 0 || peersQuery.isError) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Linked</CardTitle>
          </CardHeader>
          <CardContent>
            {peersQuery.isError ? (
              <p className="text-sm text-destructive" role="alert">
                Could not load linked instances.
              </p>
            ) : (
              <ul className="divide-y">
                {peers.map((peer) => (
                  <li
                    key={peer.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      {renamingId === peer.id ? (
                        <form
                          className="flex gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            renameMutation.mutate({
                              id: peer.id,
                              name: renameDraft.trim(),
                            });
                          }}
                        >
                          <Input
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            aria-label={`New name for ${peer.name}`}
                            autoFocus
                            className="h-8"
                          />
                          <Button
                            type="submit"
                            size="sm"
                            disabled={
                              renameMutation.isPending ||
                              renameDraft.trim().length === 0
                            }
                          >
                            Save
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenamingId(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {/* div, not p: Badge renders a div, which cannot
                              nest inside a paragraph. */}
                          <span className="truncate">{peer.name}</span>
                          {peer.allowLaunch && <Badge>can launch here</Badge>}
                          {peer.allowMessage && (
                            <Badge variant="running">can message here</Badge>
                          )}
                          {peer.allowFullAccess && (
                            <Badge variant="error">full access</Badge>
                          )}
                        </div>
                      )}
                      {renamingId === peer.id && renameMutation.isError && (
                        <p className="text-sm text-destructive" role="alert">
                          {(renameMutation.error as Error).message}
                        </p>
                      )}
                      <p className="truncate text-sm text-muted-foreground">
                        {peer.url}
                        {peer.tailnetStableId ? " · tailnet-pinned" : ""}
                        {peer.reportedName && peer.reportedName !== peer.name
                          ? ` · calls itself ${peer.reportedName}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Rename ${peer.name}`}
                        onClick={() => {
                          renameMutation.reset();
                          setRenamingId(peer.id);
                          setRenameDraft(peer.name);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Unlink ${peer.name}`}
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(peer.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
