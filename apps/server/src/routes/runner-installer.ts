import type { FastifyInstance, FastifyRequest } from "fastify";
import { RunnerRequestError } from "../agents/remote/service.js";
import { normalizeFingerprint } from "../agents/remote/x509.js";
import type { RunnerArtifactSource } from "../server/runner-artifacts.js";
import { hostHint } from "./runners.js";

const BOOTSTRAP = "install-dispatch-runner.sh";
const ARCHIVE = "dispatch-server.tar.gz";
const DEV_FLAG = "--allow-unverified-dev-build";
const ORIGIN =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type HostedRunnerInstall = {
  /** `https://host:port` of the runner listener, or the web origin. */
  origin: string;
  revision: string;
  version: string;
  /** SHA-256 of the runner listener's private CA. Required with its origin. */
  caFingerprint?: string;
  /** Present only for an unverified dev build: digests to check instead. */
  dev?: { bootstrapSha256: string; archiveSha256: string };
};

/**
 * The one command Settings copies to install or update a runner from this
 * controller's own build. It runs in the operator's shell and defines
 * `dispatch_runner_install`, so flags for the installer (`--user`,
 * `--dedicated-user`, or the dev-build acceptance) are added by running it
 * again with them. Nothing downloaded runs as root before it is verified:
 * a release bootstrap by its Sigstore provenance, a dev bootstrap by the
 * digest embedded here. An https origin trusts only the pinned runner CA,
 * fetched and checked the same way `dispatch-runner connect` checks it.
 */
export function hostedRunnerInstallCommand(input: HostedRunnerInstall) {
  const { origin, revision, version, dev } = input;
  if (!ORIGIN.test(origin)) throw new Error("Invalid runner artifact origin");
  if (!/^[a-f0-9]{7,40}$/.test(revision))
    throw new Error("Invalid runner revision");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Invalid runner version");
  if (
    dev &&
    !(SHA256.test(dev.bootstrapSha256) && SHA256.test(dev.archiveSha256))
  )
    throw new Error("Invalid runner digest");
  const https = origin.startsWith("https://");
  const pin =
    input.caFingerprint === undefined
      ? undefined
      : normalizeFingerprint(input.caFingerprint)
          .replace(/:/g, "")
          .toLowerCase();
  if (pin && !https) throw new Error("A pinned CA needs an https origin");
  const scheme = https ? "https" : "http";
  const cacert = pin ? ' --cacert "$dir/ca.pem"' : "";
  const build = `Dispatch ${version} (${revision})`;
  const fail = (message: string) =>
    `{ echo '${message.replace(/'/g, "'\\''")}' >&2; exit 1; }`;
  const lines = [
    "dispatch_runner_install() (",
    "  set -eu",
    ...(dev
      ? [
          `  case " $* " in *' ${DEV_FLAG} '*) ;; *) ${fail(
            `error: This controller serves an unverified dev build of ${build}. To install it anyway, run: dispatch_runner_install ${DEV_FLAG}`
          )} ;; esac`,
        ]
      : []),
    `  base='${origin}/api/v1/runner-artifacts/${revision}'`,
    "  dir=$(mktemp -d)",
    "  trap 'rm -rf -- \"$dir\"' EXIT",
    ...(pin
      ? [
          `  curl -qfsSk --proto '=https' --max-filesize 65536 '${origin}/api/v1/runner-artifacts/ca.pem' -o "$dir/ca.pem"`,
          `  [ "$(sed '/-----/d' "$dir/ca.pem" | base64 -d | sha256sum | cut -c1-64)" = '${pin}' ] || ${fail(
            "error: The runner CA does not match Dispatch Settings."
          )}`,
        ]
      : []),
    `  dispatch_fetch() { curl -qfsSL --proto '=${scheme}' --proto-redir '=${scheme}'${cacert} "$base/$1" -o "$dir/$1"; }`,
    `  dispatch_fetch ${BOOTSTRAP}`,
    ...(dev
      ? [
          `  [ "$(sha256sum < "$dir/${BOOTSTRAP}" | cut -c1-64)" = '${dev.bootstrapSha256}' ] || ${fail(
            "error: The downloaded installer does not match this Dispatch build. Copy the command again."
          )}`,
          `  echo 'warning: Installing an unverified dev build of ${build}. Only its SHA-256 digests are checked.' >&2`,
        ]
      : [
          `  dispatch_fetch ${BOOTSTRAP}.sigstore.json`,
          `  gh attestation verify "$dir/${BOOTSTRAP}" --hostname github.com --bundle "$dir/${BOOTSTRAP}.sigstore.json" --repo selfcontained/dispatch --signer-workflow selfcontained/dispatch/.github/workflows/release.yml`,
        ]),
    `  sudo bash "$dir/${BOOTSTRAP}" install --tag v${version} --source "$base"${cacert}${
      dev ? ` --sha256 '${dev.archiveSha256}'` : ""
    } "$@"`,
    ")",
    "dispatch_runner_install",
  ];
  return lines.join("\n");
}

type ArtifactEndpoint = {
  artifactEndpoint(
    hostHint?: string
  ): Promise<{ origin: string; caFingerprint: string }>;
};

function webOrigin(request: FastifyRequest) {
  return `${request.protocol}://${request.headers.host ?? ""}`;
}

export function registerRunnerInstaller(
  app: FastifyInstance,
  deps: {
    runners: ArtifactEndpoint;
    artifacts: Pick<RunnerArtifactSource, "enabled" | "kind" | "get">;
    build: { revision: string | null; version: string };
  }
) {
  const { runners, artifacts, build } = deps;
  app.get("/api/v1/runners/installer", async (request, reply) => {
    const { revision, version } = build;
    const unavailable = { revision, version, source: null, command: null };
    if (!revision || !artifacts.enabled) return unavailable;
    // The runner listener by default: its pinned CA authenticates the bytes
    // in transit. Without one, the web origin still works because every
    // byte is verified before use.
    let origin: string;
    let caFingerprint: string | undefined;
    try {
      ({ origin, caFingerprint } = await runners.artifactEndpoint(
        hostHint(request.headers.host)
      ));
    } catch (error) {
      if (!(error instanceof RunnerRequestError) || error.status !== 409)
        throw error;
      origin = webOrigin(request);
    }
    let dev: HostedRunnerInstall["dev"];
    if (artifacts.kind === "dev") {
      try {
        const files = new Map(
          (await artifacts.get()).files.map((file) => [file.name, file.sha256])
        );
        dev = {
          bootstrapSha256: files.get(BOOTSTRAP)!,
          archiveSha256: files.get(ARCHIVE)!,
        };
      } catch (err) {
        request.log.error({ err }, "Could not prepare runner dev artifacts");
        return reply.code(503).send({
          error: "The runner installer could not be prepared.",
        });
      }
    }
    try {
      return {
        revision,
        version,
        source: artifacts.kind,
        command: hostedRunnerInstallCommand({
          origin,
          revision,
          version,
          caFingerprint,
          dev,
        }),
      };
    } catch {
      return unavailable;
    }
  });
}
