#!/bin/sh
# Container entrypoint: stage a pre-provisioned guest workspace with a
# runner-unique marker for configured runners, then idle. The harness
# connects and starts the runners with `docker exec` so tests control timing.
set -eu
NAME="$1"
if ! command -v ps >/dev/null || ! command -v setpriv >/dev/null; then
  echo "Runner fixture image needs procps and util-linux." >&2
  exit 1
fi
install -d -m 700 /run/cfg /var/lib/runner
install -d -m 755 /home/guest /etc/dispatch-runner
# The runner reads the workload account (uid/gid 1500, home /home/guest in
# runner.json) from passwd at start, as a real install provides it.
getent group 1500 >/dev/null || groupadd -g 1500 guest
getent passwd 1500 >/dev/null || useradd -u 1500 -g 1500 -M -d /home/guest guest
cp /etc/runner/runner.json /run/cfg/runner.json && chmod 600 /run/cfg/runner.json
if [ "$NAME" != scratch ]; then
  WS="/opt/dispatch-guest-proof"
  mkdir -p "$WS/.dispatch"
  cat > "$WS/.dispatch/tools.json" <<'EOF'
{"tools":[{"name":"proof","description":"Write the runner acceptance marker","command":["/bin/sh","-c","echo ran > repo-op"]}]}
EOF
  echo "marker-$NAME-$(cat /proc/sys/kernel/random/uuid)" > "$WS/marker.txt"
  chown -R 1500:1500 "$WS"
fi
# Only the fixture runner advertises this synthetic CLI as ready.
cat > /usr/local/bin/fixture-claude <<'EOF'
#!/bin/sh
case "$*" in
  --version) echo '0.0.0-fixture' ;;
  'auth status --json') echo '{"loggedIn":true}' ;;
  *) exit 64 ;;
esac
EOF
chmod 755 /usr/local/bin/fixture-claude
chown 1500:1500 /home/guest
exec sleep infinity
