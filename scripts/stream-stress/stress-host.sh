#!/bin/bash
# DISPATCH_AGENT_HOST_COMMAND for a stream-stress stack: the agent host with
# the stress engine standing in for every adapter. The server strips DISPATCH_*
# from the host's environment, so the adapter override is set here instead.
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export DISPATCH_ACP_ADAPTER_COMMAND="[\"$here/stress-acp-agent.mjs\"]"
exec bun "$root/apps/server/src/main.ts" agent-host "$@"
