/** Implementation ports supplied by the entry when workload and controller share a process. */
import type { Req, Res } from "./contract/index.js";
import type { CheckoutState } from "./checkout.js";
import type { CheckoutReadName } from "./checkout-reads.js";
import type { GitQueryName } from "./execution.js";
import type { EngineBins } from "./host.js";

export type InProcessEngines = {
  models(request: Req<"engine.models">): Promise<Res<"engine.models">>;
  usage(request: Req<"engine.usage">): Promise<Res<"engine.usage">>;
  quotaReset(
    request: Req<"engine.quota.reset">
  ): Promise<Res<"engine.quota.reset">>;
  updateInspect(
    request: Req<"engine.update.inspect">
  ): Promise<Res<"engine.update.inspect">>;
  updateSpawn(
    request: Req<"engine.update.spawn">
  ): Promise<Res<"engine.update.spawn">>;
  updateRelease(
    request: Req<"engine.update.release">
  ): Promise<Res<"engine.update.release">>;
  updateProbe(
    request: Req<"engine.update.probe">
  ): Promise<Res<"engine.update.probe">>;
  operation(request: Req<"engine.operation">): Promise<Res<"engine.operation">>;

  pluginStatus(
    request: Req<"engine.plugin.status">
  ): Promise<Res<"engine.plugin.status">>;
  pluginApply(
    request: Req<"engine.plugin.apply">
  ): Promise<Res<"engine.plugin.apply">>;
  list(request: Req<"engine.list">): Promise<Res<"engine.list">>;
  loginStart(
    request: Req<"engine.login.start">,
    onUpdate: (login: Res<"engine.login.start">) => void
  ): Promise<Res<"engine.login.start">>;
  loginSubmit(
    request: Req<"engine.login.submit">
  ): Promise<Res<"engine.login.submit">>;
  loginStatus(
    request: Req<"engine.login.status">
  ): Promise<Res<"engine.login.status">>;
  loginCancel(
    request: Req<"engine.login.cancel">
  ): Promise<Res<"engine.login.cancel">>;
  close(): void;
};

type Selector = "current" | "launch" | "moved";
type WorkloadOp =
  | CheckoutReadName
  | GitQueryName
  | "git.context"
  | "checkout.exec"
  | "checkout.write"
  | "path.resolve";
type Input<K extends WorkloadOp> = {
  directory: string;
  request: Omit<Req<K>, "target">;
} & (K extends "checkout.exec" ? { selector: Selector } : unknown) &
  (K extends "git.context" ? { checkoutBranch?: string } : unknown);

type Read<K extends "github.pr.head" | "github.pr.diff" | "github.pr.details"> =
  (request: Req<K>) => Promise<Res<K>>;

export interface LaunchFolderProbes {
  inspect(path: string): Promise<Res<"path.resolve">>;
  complete(request: Req<"path.complete">): Promise<Res<"path.complete">>;
  remoteHeads(request: Req<"git.remoteHeads">): Promise<Res<"git.remoteHeads">>;
}

export interface InProcessPorts<Bytes extends Uint8Array> {
  launchProbes: LaunchFolderProbes;
  checkoutWorkload: {
    run<K extends WorkloadOp>(
      op: K,
      input: Input<K>,
      options: { signal?: AbortSignal }
    ): Promise<Res<K>>;
    watch(
      directory: string,
      changed: () => void,
      closed: () => void
    ): () => void;
  };
  workspaceWorkload: {
    resolvePath(
      path: string,
      options?: Omit<Req<"path.resolve">, "path">
    ): Promise<Res<"path.resolve">>;
    observe(path: string): Promise<CheckoutState>;
    gone(path: string): Promise<boolean>;
    git(path: string): Promise<{ worktreePath: string } | null | "error">;
    release(
      session: string,
      checkout: { path: string; identity?: string },
      request: Pick<Req<"workspace.release">, "deleteBranch" | "originalBranch">
    ): Promise<boolean>;
  };
  githubWorkload: {
    pullRequestHead: Read<"github.pr.head">;
    pullRequestDetails: Read<"github.pr.details">;
    pullRequestDiff: Read<"github.pr.diff">;
    pullRequestStatus(
      request: Req<"github.pr.status">,
      options: { signal?: AbortSignal }
    ): Promise<Res<"github.pr.status">>;
  };
  sessionFilesWorkload: {
    put(source: string, purpose: "prompt" | "reference"): Promise<string>;
    get(source: string): Promise<Bytes>;
  };
  localEnginePort(bins?: EngineBins): InProcessEngines;
  readCommandGuard(
    directory: string,
    selector: Selector,
    file: string
  ): Promise<{ root: string; content: string | null; digest: string }>;
  hostCommand(): string[];
}
