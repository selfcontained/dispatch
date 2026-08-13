import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Loader2, MonitorSmartphone, Trash2 } from "lucide-react";
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
  passwordSet: boolean;
  tailscale: { dnsName: string; stableId: string } | null;
  bind: {
    enabled: boolean;
    active: boolean;
    address: string | null;
    blockedReason: "no-password" | "no-tailscale" | null;
  };
};

type Peer = {
  id: string;
  name: string;
  url: string;
  tailnetStableId: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  allowLaunch: boolean;
};

type PairingOffer = {
  pairingId: string;
  code: string;
  expiresAt: string;
  address: string | null;
};

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

  const offerMutation = useMutation({
    mutationFn: () =>
      api<PairingOffer>("/api/v1/peers/pairings", {
        method: "POST",
        body: JSON.stringify({ allowLaunch: true, requireTailnet: true }),
      }),
  });

  const [linkAddress, setLinkAddress] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const linkMutation = useMutation({
    mutationFn: () =>
      api<{ peer: Peer }>("/api/v1/peers/link", {
        method: "POST",
        body: JSON.stringify({
          address: linkAddress.trim(),
          code: linkCode.trim(),
          allowLaunch: true,
        }),
      }),
    onSuccess: () => {
      setLinkAddress("");
      setLinkCode("");
      void queryClient.invalidateQueries({ queryKey: peersQueryKey });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (peerId: string) =>
      api(`/api/v1/peers/${peerId}`, { method: "DELETE" }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: peersQueryKey }),
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
        <CardContent className="space-y-3">
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
            <Button
              variant="default"
              disabled={offerMutation.isPending || !self?.passwordSet}
              onClick={() => offerMutation.mutate()}
            >
              <MonitorSmartphone className="mr-2 h-4 w-4" />
              Show pairing code
            </Button>
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
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {peer.name}
                        {peer.allowLaunch && (
                          <Badge className="ml-2">can launch here</Badge>
                        )}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {peer.url}
                        {peer.tailnetStableId ? " · tailnet-pinned" : ""}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Unlink ${peer.name}`}
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(peer.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
