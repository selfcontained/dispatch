#!/bin/bash
# DISPATCH_AGENT_HOST_COMMAND for a stream-stress stack. The server supplies
# the stress adapter through the launch file.
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
exec bun "$root/apps/server/src/main.ts" agent-host "$@"
