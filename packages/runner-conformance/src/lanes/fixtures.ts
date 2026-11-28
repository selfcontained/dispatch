/** Finite CLI fixture: no provider, credentials, or network; unknown calls fail closed. */
export const FIXTURE_GITHUB = `#!/bin/sh
set -eu
config="\${GH_CONFIG_DIR:-$HOME/.config/gh}"
mkdir -p "$config"
printf '%s\\n' "$*" >> "$config/fixture-invocations"
case "$*" in
  'config get user --host github.com')
    if [ -f "$config/fixture-signed-in" ]; then printf 'fixture-user\\n'; exit 0; fi
    printf 'could not find key "user"\\n' >&2; exit 1 ;;
  *'user/repos'*)
    case "$*" in *'page=1 '*) printf '%s\\n' '[{"name":"fixture/sample","url":"https://github.com/fixture/sample"}]';; *) printf '[]\\n';; esac ;;
  *'repos/fixture/sample/branches?per_page=100'*) printf '%s\\n' '["main","feature/fixture"]' ;;
  *'repos/fixture/sample --jq .default_branch'*) printf 'main\\n' ;;
  *' user --jq '*) printf '%s\\n' '{"login":"fixture-user","id":12345,"name":"Fixture User"}' ;;
  'auth logout '*) rm -f "$config/fixture-signed-in" ;;
  *) printf 'Unexpected fixture gh invocation: %s\\n' "$*" >&2; exit 64 ;;
esac
`;
