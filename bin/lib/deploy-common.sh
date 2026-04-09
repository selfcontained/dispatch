# Shared deploy functions sourced by dispatch-deploy and install-launchd.
# Expects the caller to set: SERVER_DIR, REPO
#
# shellcheck shell=bash

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
  else
    echo "error: nvm not found at $NVM_DIR/nvm.sh" >&2
    return 1
  fi
}

# Deploy from a pre-built release artifact attached to a GitHub release.
# Returns 0 on success, 1 if the artifact isn't available (caller should
# fall back to build_from_source).
deploy_from_artifact() {
  local tag="$1"
  local tarball="/tmp/dispatch-release-${tag}.tar.gz"

  if ! command -v gh &>/dev/null; then
    return 1
  fi
  if ! gh release download "$tag" \
       --pattern "dispatch-release.tar.gz" \
       --output "$tarball" \
       --clobber \
       --repo "$REPO" 2>/dev/null; then
    rm -f "$tarball"
    return 1
  fi

  # Ensure we're on the right commit so git describe works for version detection
  git -C "$SERVER_DIR" fetch --tags --quiet
  git -C "$SERVER_DIR" checkout "$tag" 2>/dev/null || true

  # Extract pre-built artifacts into the server directory
  tar xzf "$tarball" --no-same-owner -C "$SERVER_DIR"
  rm -f "$tarball"

  # Install dependencies (rebuilds native modules for this host)
  load_nvm
  cd "$SERVER_DIR"
  nvm use >/dev/null
  pnpm install --frozen-lockfile
}

# Full build from source — checkout tag, install deps, compile everything.
build_from_source() {
  local tag="$1"
  git -C "$SERVER_DIR" checkout "$tag"
  load_nvm
  cd "$SERVER_DIR"
  nvm use >/dev/null
  pnpm install --frozen-lockfile
  pnpm run build
}
