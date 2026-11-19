#!/bin/sh
# Executed only in the disposable Linux acceptance containers.
set -eu
runner=$1
install -m 755 /tmp/fixture-gh /usr/bin/gh
printf '%s\n' "$runner" >/etc/field-runner-name
printf '127.0.0.1 github.com\n' >> /etc/hosts
if [ "$runner" != scratch ]; then exit 0; fi

# Authenticate a real Git checkout against a runner-local HTTPS origin.
root=/tmp/private-git
mkdir -p "$root/repos/fixture-scratch"
git init -q -b main "$root/seed"
git -C "$root/seed" config user.name Fixture
git -C "$root/seed" config user.email fixture@example.test
echo "private checkout on scratch" > "$root/seed/review-marker.txt"
git -C "$root/seed" add .
git -C "$root/seed" commit -qm 'Seed private repository'
git clone -q --bare "$root/seed" "$root/repos/fixture-scratch/private.git"
git --git-dir="$root/repos/fixture-scratch/private.git" config http.receivepack true
openssl req -newkey rsa:2048 -x509 -nodes -days 1 -subj '/CN=github.com' \
  -addext 'subjectAltName=DNS:github.com' -keyout "$root/key" \
  -out /usr/local/share/ca-certificates/runner-test-github.crt >/dev/null 2>&1
update-ca-certificates >/dev/null 2>&1
