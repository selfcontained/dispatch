#!/usr/bin/env bash
# Availability/version probe only. Real ACP execution uses fake-acp-agent.mjs.
# Refuse everything else so a test cannot accidentally sign in or call a model.
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  echo "0.0.0-e2e"
  exit 0
fi
echo "E2E engine stub only supports --version; use the fake ACP adapter" >&2
exit 64
