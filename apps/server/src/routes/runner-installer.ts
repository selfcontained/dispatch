import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  RUNNER_INSTALL_PATH,
  RUNNER_LISTENER_INSTALL_PATH,
  RUNNER_LISTENER_ORIGIN_HEADER,
  RunnerRequestError,
} from "../agents/remote/service.js";
import {
  RUNNER_ARCHES,
  runnerArchiveName,
  type RunnerArch,
  type RunnerArtifactSource,
} from "../server/runner-artifacts.js";
import { hostHint } from "./runners.js";

const BOOTSTRAP = "install-dispatch-runner.sh";
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
  dev?: {
    bootstrapSha256: string;
    archiveSha256: Partial<Record<RunnerArch, string>>;
  };
};

/**
 * The script the one-liner pipes into `sudo bash`: it installs a clean runner
 * or updates a managed one from this controller's own build. Nothing it
 * downloads runs before it is verified: a release bootstrap by its Sigstore
 * provenance, a dev bootstrap by the digest embedded here and only after the
 * operator passed the dev flag. Over the listener, every further download
 * trusts only the runner CA this pinned response carries. The brace group
 * contains both the function and its call, with no bytes outside it.
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
    !(
      SHA256.test(dev.bootstrapSha256) &&
      RUNNER_ARCHES.every(
        (arch) =>
          dev.archiveSha256[arch] === undefined ||
          SHA256.test(dev.archiveSha256[arch]!)
      )
    )
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
    "{",
    `# Installs or updates a Dispatch runner from ${build}.`,
    `# Options: ${command.replace(/ \| sudo bash$/, " | sudo bash -s -- [--user USER | --dedicated-user] [--allow-downgrade] [--clear-unreadable-fence]")}`,
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
    `  [ "$(uname -s)" = Linux ] || ${fail("error: Dispatch runners require Linux.")}`,
    '  case "$(uname -m)" in',
    "    x86_64) arch=x64 ;;",
    "    aarch64|arm64) arch=arm64 ;;",
    `    *) ${fail("error: Dispatch runners require Linux on x64 or arm64.")} ;;`,
    "  esac",
    ...(dev
      ? [
          '  case "$arch" in',
          ...RUNNER_ARCHES.map(
            (arch) =>
              `    ${arch}) digest=${quote(dev.archiveSha256[arch] ?? "")} ;;`
          ),
          "  esac",
          `  [ -n "$digest" ] || ${fail("error: No dev runner payload is available for this architecture. Check the controller logs.")}`,
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
    `  fetch() { http=$(curl -qfsSL --proto '=${scheme}' --proto-redir '=${scheme}'${cacert} -w '%{http_code}' "$base/$1" -o "$dir/\${2:-$1}" < /dev/null); }`,
    // 503: this release has the payload but the controller could not fetch
    // or verify it; anything else keeps the old-release explanation.
    `  fetch "install-dispatch-runner-linux-$arch.sh" ${BOOTSTRAP}${dev ? "" : ` || { [ "$http" != 503 ] || { echo ${quote("error: The controller could not fetch or verify the Linux ")}"$arch"${quote(` runner payload for ${build}. Check the controller logs.`)} >&2; exit 1; }; ${fail(`error: Could not download the release installer for ${build}. The controller must publish attested native runner payloads.`)}; }`}`,
    ...(dev
      ? [
          `  [ "$(sha256sum < "$dir/${BOOTSTRAP}" | cut -c1-64)" = '${dev.bootstrapSha256}' ] || ${fail(
            "error: The downloaded installer does not match this Dispatch build. Copy the command again."
          )}`,
          `  echo ${quote(`warning: Installing an unverified dev build of ${build}. Only its SHA-256 digests are checked.`)} >&2`,
        ]
      : [
          `  fetch "install-dispatch-runner-linux-$arch.sh.sigstore.json" ${BOOTSTRAP}.sigstore.json`,
          // Match account_command in the installer when loading the user's gh.
          '  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then',
          `    entry=$(getent -- passwd "$SUDO_USER") || ${fail("error: Cannot look up the invoking account for release verification.")}`,
          "    IFS=: read -r account ignored uid gid ignored home shell <<EOF",
          "$entry",
          "EOF",
          `    case $uid in '' | 0* | *[!0-9]*) ${fail("error: Invalid invoking account for release verification.")} ;; esac`,
          `    case $gid in '' | *[!0-9]*) ${fail("error: Invalid invoking account for release verification.")} ;; esac`,
          `    case $home in /*) ;; *) ${fail("error: Invalid invoking account for release verification.")} ;; esac`,
          '    case ${shell##*/} in bash|zsh|sh|dash) [ -x "$shell" ] || shell=/bin/bash ;; *) shell=/bin/bash ;; esac',
          '    chmod 0711 "$dir"',
          `    chmod 0644 "$dir/${BOOTSTRAP}" "$dir/${BOOTSTRAP}.sigstore.json"`,
          "    run_gh() {",
          '      setpriv --reuid="$uid" --regid="$gid" --init-groups env -i HOME="$home" USER="$account" LOGNAME="$account" PATH=/usr/local/bin:/usr/bin:/bin \\',
          '        "$shell" -lc \'[ -f "$HOME/.dispatch/env" ] && . "$HOME/.dispatch/env"; export PATH="${PATH:+$PATH:}$HOME/.local/bin"; command -v gh > /dev/null || { echo "error: Install GitHub CLI 2.49 or newer to verify this Dispatch release." >&2; exit 1; }; exec gh "$@"\' dispatch-account-command "$@"',
          "    }",
          "  else",
          `    command -v gh > /dev/null || ${fail("error: Install GitHub CLI 2.49 or newer to verify this Dispatch release.")}`,
          '    run_gh() { gh "$@"; }',
          "  fi",
          `  run_gh attestation verify "$dir/${BOOTSTRAP}" --hostname github.com --bundle "$dir/${BOOTSTRAP}.sigstore.json" --repo selfcontained/dispatch --signer-workflow selfcontained/dispatch/.github/workflows/release.yml < /dev/null`,
        ]),
    `  bash "$dir/${BOOTSTRAP}" install --tag v${version} --source "$base"${cacert}${
      dev ? ' --sha256 "$digest"' : ""
    } "$@" < /dev/null`,
    ")",
    'dispatch_runner_install "$@"',
    "}",
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
    artifacts: Pick<
      RunnerArtifactSource,
      "enabled" | "kind" | "get" | "preparationFailed"
    >;
    build: { revision: string | null; version: string };
  }
) {
  const { runners, artifacts, build } = deps;

  app.get("/api/v1/runners/installer", async (request) => {
    const { revision, version } = build;
    const unavailable = { revision, version, source: null, command: null };
    if (!revision || !artifacts.enabled || artifacts.preparationFailed())
      return unavailable;
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
      if (artifacts.preparationFailed()) return unavailable;
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
          const bootstrap = (await artifacts.get()).files.find(
            (file) => file.name === BOOTSTRAP
          );
          if (!bootstrap)
            throw new Error("The dev runner bootstrap is missing");
          const archiveSha256: Partial<Record<RunnerArch, string>> = {};
          await Promise.all(
            RUNNER_ARCHES.map(async (arch) => {
              try {
                const { files } = await artifacts.get(arch);
                const archive = files.find(
                  (file) => file.name === runnerArchiveName(arch)
                );
                if (archive) archiveSha256[arch] = archive.sha256;
              } catch (err) {
                request.log.error(
                  { err, arch },
                  "Could not prepare runner dev payload"
                );
              }
            })
          );
          dev = { bootstrapSha256: bootstrap.sha256, archiveSha256 };
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
