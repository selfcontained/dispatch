#!/bin/sh
# A deterministic GitHub CLI stand-in. Only synthetic credentials exist in these containers.
set -eu
test "$(id -u)" = 1500
name=$(cat /etc/field-runner-name)
login="fixture-$name"
saved="${GH_CONFIG_DIR:-$HOME/.config/gh}"
key="$saved/fixture-account"
case "$1 ${2:-}" in
  'config get')
    if [ -s "$key" ]; then cat "$key"; else echo 'could not find key "user"' >&2; exit 1; fi
    ;;
  'auth login')
    printf '! First copy your one-time code: B123-C456\nOpen this URL to continue in your web browser: https://github.com/login/device\n' >&2
    while [ ! -f /tmp/github-fixture-approved ]; do sleep .1; done
    (umask 077; mkdir -p "$saved"; printf '%s\n' "$login" > "$key")
    ;;
  'auth status')
    test -s "$key" || exit 1
    case " $* " in
      *' --json '*) printf '{"hosts":{"github.com":[{"active":true,"login":"%s","state":"success","host":"github.com"}]}}\n' "$login" ;;
      *) printf 'github.com\n  ✓ Logged in to github.com account %s\n' "$login" ;;
    esac
    ;;
  'auth logout') rm -f "$key" ;;
  'auth setup-git') git config --global credential.https://github.com.helper '!/usr/bin/gh auth git-credential' ;;
  'auth git-credential')
    test "$3" = get || exit 0
    test -s "$key"
    grep -qx 'host=github.com' || exit 1
    printf 'username=%s\npassword=test-only-%s\n\n' "$login" "$name"
    ;;
  'api user'|'api --hostname')
    test -s "$key"
    case " $* " in
      *'/pulls/'*) printf '{"url":"https://github.com/%s/private.git","branch":"review-topic"}\n' "$login" ;;
      *' user '*) printf '%s\n' "$login" ;;
      *) exit 1 ;;
    esac
    ;;
  'search repos')
    test -s "$key"
    printf '[{"fullName":"%s/private","url":"https://github.com/%s/private"}]\n' "$login" "$login"
    ;;
  *) [ "$1" = --version ] && echo 'gh version 2.86.0 (fixture)' ;;
esac
