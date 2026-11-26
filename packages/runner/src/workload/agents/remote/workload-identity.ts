export const setpriv = "/usr/bin/setpriv";

// Bun versions disagree on whether spawn and execFile apply uid/gid. Make
// the kernel privilege transition the same for the ACP host and repo tools.
export function executionArgs(uid: number, gid: number) {
  return [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--init-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
  ];
}
