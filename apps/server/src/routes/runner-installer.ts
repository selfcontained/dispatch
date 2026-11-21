import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  RUNNER_INSTALL_PATH,
  RUNNER_LISTENER_INSTALL_PATH,
  RUNNER_LISTENER_ORIGIN_HEADER,
  RunnerRequestError,
} from "../agents/remote/service.js";
import type { RunnerArtifactSource } from "../server/runner-artifacts.js";
import { hostHint } from "./runners.js";

const BOOTSTRAP = "install-dispatch-runner.sh";
const ARCHIVE = "dispatch-server.tar.gz";
const DEV_FLAG = "--allow-unverified-dev-build";
const ORIGIN =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** Base64 SHA-256 of a DER SubjectPublicKeyInfo, as curl's --pinnedpubkey takes it. */
const PIN = /^[A-Za-z0-9+/]{43}=$/;
const PEM =
  /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END CERTIFICATE-----\n?$/;

/** Single-quote a value for a POSIX shell. */
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function checkOrigin(origin: string) {
  if (!ORIGIN.test(origin)) throw new Error("Invalid runner artifact origin");
}

/**
 * The one-liner Settings copies. Over the runner listener, curl pins the
 * listener's public key, which authenticates the controller even with `-k`;
 * the script it fetches carries everything else. Without the listener, the
 * web origin serves the same script.
 */
export function runnerInstallCommand(input: { origin: string; pin?: string }) {
  const { origin, pin } = input;
  checkOrigin(origin);
  if (pin === undefined)
    return `curl -fsSL ${origin}${RUNNER_INSTALL_PATH} | sudo bash`;
  if (!origin.startsWith("https://"))
    throw new Error("A pinned key needs an https origin");
  if (!PIN.test(pin)) throw new Error("Invalid runner listener pin");
  return `curl -fsSk --pinnedpubkey 'sha256//${pin}' ${origin}${RUNNER_LISTENER_INSTALL_PATH} | sudo bash`;
}

export type RunnerInstallScript = {
  /** `https://host:port` of the runner listener, or the web origin. */
  origin: string;
  revision: string;
  version: string;
  /** The listener's runner CA; required with a listener origin. */
  caPem?: string;
  /** The one-liner that fetched this script, quoted in the dev refusal. */
  command: string;
  /** Present only for an unverified dev build: digests to check instead. */
  dev?: { bootstrapSha256: string; archiveSha256: string };
};

/**
 * The script the one-liner pipes into `sudo bash`: it installs a clean runner
 * or updates a managed one from this controller's own build. Nothing it
 * downloads runs before it is verified: a release bootstrap by its Sigstore
 * provenance, a dev bootstrap by the digest embedded here and only after the
 * operator passed the dev flag. Over the listener, every further download
 * trusts only the runner CA this pinned response carries. The body is one
 * function, and its call is a brace group on the last line, so a truncated
 * download is a syntax error rather than half a script.
 */
export function runnerInstallScript(input: RunnerInstallScript) {
  const { origin, revision, version, caPem, command, dev } = input;
  checkOrigin(origin);
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
  if (caPem !== undefined && !(https && PEM.test(caPem)))
    throw new Error("Invalid runner CA");
  const scheme = https ? "https" : "http";
  const cacert = caPem ? ' --cacert "$dir/ca.pem"' : "";
  const build = `Dispatch ${version} (${revision})`;
  const fail = (message: string) => `{ echo ${quote(message)} >&2; exit 1; }`;
  const lines = [
    "#!/bin/sh",
    `# Installs or updates a Dispatch runner from ${build}.`,
    `# Options: ${command.replace(/ \| sudo bash$/, " | sudo bash -s -- [--user USER | --dedicated-user]")}`,
    "dispatch_runner_install() (",
    "  set -eu",
    `  [ "$(id -u)" = 0 ] || ${fail(`error: Run this as root: ${command}`)}`,
    ...(dev
      ? [
          "  accepted=",
          `  for arg do [ "$arg" != ${DEV_FLAG} ] || accepted=1; done`,
          '  if [ -z "$accepted" ]; then',
          `    retry=${quote(`${command} -s -- ${DEV_FLAG}`)}`,
          "    for arg do",
          "      case $arg in",
          `        '' | *[!A-Za-z0-9_./:=@-]*) retry="$retry '$(printf '%s' "$arg" | sed "s/'/'\\\\\\\\''/g")'" ;;`,
          '        *) retry="$retry $arg" ;;',
          "      esac",
          "    done",
          `    echo ${quote(`error: This controller serves an unverified dev build of ${build}. To install it anyway, run:`)} >&2`,
          `    printf '  %s\\n' "$retry" >&2`,
          "    exit 1",
          "  fi",
        ]
      : []),
    `  base=${quote(`${origin}/api/v1/runner-artifacts/${revision}`)}`,
    "  dir=$(mktemp -d)",
    "  trap 'rm -rf -- \"$dir\"' EXIT",
    ...(caPem
      ? [
          `  printf '%s\\n' ${caPem
            .trim()
            .split("\n")
            .map((line) => quote(line))
            .join(" ")} > "$dir/ca.pem"`,
        ]
      : []),
    `  fetch() { curl -qfsSL --proto '=${scheme}' --proto-redir '=${scheme}'${cacert} "$base/$1" -o "$dir/$1" < /dev/null; }`,
    `  fetch ${BOOTSTRAP}`,
    ...(dev
      ? [
          `  [ "$(sha256sum < "$dir/${BOOTSTRAP}" | cut -c1-64)" = '${dev.bootstrapSha256}' ] || ${fail(
            "error: The downloaded installer does not match this Dispatch build. Copy the command again."
          )}`,
          `  echo ${quote(`warning: Installing an unverified dev build of ${build}. Only its SHA-256 digests are checked.`)} >&2`,
        ]
      : [
          `  fetch ${BOOTSTRAP}.sigstore.json`,
          // sudo's secure PATH often hides the invoking user's own GitHub CLI.
          "  gh=$(command -v gh || :)",
          '  if [ -z "$gh" ] && [ -n "${SUDO_USER:-}" ]; then',
          `    gh=$(sudo -H -u "$SUDO_USER" sh -lc 'command -v gh' < /dev/null 2> /dev/null | tail -n 1 || :)`,
          "  fi",
          `  [ -n "$gh" ] || ${fail("error: Install GitHub CLI 2.49 or newer to verify this Dispatch release.")}`,
          `  "$gh" attestation verify "$dir/${BOOTSTRAP}" --hostname github.com --bundle "$dir/${BOOTSTRAP}.sigstore.json" --repo selfcontained/dispatch --signer-workflow selfcontained/dispatch/.github/workflows/release.yml < /dev/null`,
        ]),
    `  bash "$dir/${BOOTSTRAP}" install --tag v${version} --source "$base"${cacert}${
      dev ? ` --sha256 '${dev.archiveSha256}'` : ""
    } "$@" < /dev/null`,
    ")",
    '{ dispatch_runner_install "$@"; }',
    "",
  ];
  return lines.join("\n");
}

/** A script that only reports why this controller cannot install a runner. */
function unavailableScript(message: string) {
  return `#!/bin/sh\necho ${quote(`error: ${message}`)} >&2\nexit 1\n`;
}

type InstallerRunners = {
  /** Prepare the listener for this host; its origin and public-key pin. */
  artifactEndpoint(hostHint?: string): Promise<{ origin: string; pin: string }>;
  /** The live listener's CA and pin, without preparing anything. */
  listenerInstall(): { caPem: string; pin: string } | undefined;
};

function webOrigin(request: FastifyRequest) {
  return `${request.protocol}://${request.headers.host ?? ""}`;
}

export function registerRunnerInstaller(
  app: FastifyInstance,
  deps: {
    runners: InstallerRunners;
    artifacts: Pick<RunnerArtifactSource, "enabled" | "kind" | "get">;
    build: { revision: string | null; version: string };
  }
) {
  const { runners, artifacts, build } = deps;

  app.get("/api/v1/runners/installer", async (request) => {
    const { revision, version } = build;
    const unavailable = { revision, version, source: null, command: null };
    if (!revision || !artifacts.enabled) return unavailable;
    // The runner listener by default: its pinned key authenticates the
    // script. Without one, the web origin serves the same script.
    let endpoint: { origin: string; pin?: string };
    try {
      endpoint = await runners.artifactEndpoint(hostHint(request.headers.host));
    } catch (error) {
      if (!(error instanceof RunnerRequestError) || error.status !== 409)
        throw error;
      endpoint = { origin: webOrigin(request) };
    }
    try {
      return {
        revision,
        version,
        source: artifacts.kind,
        command: runnerInstallCommand(endpoint),
      };
    } catch {
      return unavailable;
    }
  });

  // Public like the artifacts it fetches. It is generated per request, so it
  // always names this controller's running revision.
  app.get(
    RUNNER_INSTALL_PATH,
    { config: { publicRunnerArtifact: true } },
    async (request, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type("text/x-shellscript; charset=utf-8");
      const { revision, version } = build;
      if (!revision || !artifacts.enabled)
        return unavailableScript(
          "This Dispatch build does not serve a runner installer."
        );
      const relayed = request.headers[RUNNER_LISTENER_ORIGIN_HEADER];
      let origin: string;
      let listener: { caPem: string; pin: string } | undefined;
      if (typeof relayed === "string") {
        listener = runners.listenerInstall();
        if (!listener)
          return unavailableScript("The runner listener is not ready.");
        origin = relayed;
      } else {
        origin = webOrigin(request);
      }
      let dev: RunnerInstallScript["dev"];
      if (artifacts.kind === "dev") {
        try {
          const files = new Map(
            (await artifacts.get()).files.map((file) => [
              file.name,
              file.sha256,
            ])
          );
          dev = {
            bootstrapSha256: files.get(BOOTSTRAP)!,
            archiveSha256: files.get(ARCHIVE)!,
          };
        } catch (err) {
          request.log.error({ err }, "Could not prepare runner dev artifacts");
          return unavailableScript(
            "The runner installer could not be prepared. Check the controller logs."
          );
        }
      }
      try {
        return runnerInstallScript({
          origin,
          revision,
          version,
          caPem: listener?.caPem,
          command: runnerInstallCommand({ origin, pin: listener?.pin }),
          dev,
        });
      } catch (err) {
        request.log.warn({ err }, "Could not compose the runner installer");
        return reply
          .code(400)
          .send(
            unavailableScript(
              "This request cannot be served a runner installer."
            )
          );
      }
    }
  );
}
