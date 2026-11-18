#!/bin/sh
# Container entrypoint: stage a pre-provisioned guest workspace with a
# runner-unique marker and a writable runner.json, then idle. The harness
# pairs and starts the runner with `docker exec` so tests control timing.
set -eu
NAME="$1"
install -d -m 700 /run/cfg /var/lib/runner
install -d -m 755 /home/guest /etc/dispatch-runner
cp /etc/runner/runner.json /run/cfg/runner.json && chmod 600 /run/cfg/runner.json
WS="/opt/dispatch-guest-$NAME-proof"
mkdir -p "$WS"
echo "marker-$NAME-$(cat /proc/sys/kernel/random/uuid)" > "$WS/marker.txt"
chown -R 1500:1500 "$WS" /home/guest
exec sleep infinity
