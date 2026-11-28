/** No credentials or network: every other invocation fails closed. */
export const FIXTURE_GITHUB = `#!/bin/sh
if [ "$*" = "config get user --host github.com" ]; then
  printf 'could not find key "user"\\n' >&2
  exit 1
fi
printf 'Unexpected fixture gh invocation\\n' >&2
exit 64
`;
