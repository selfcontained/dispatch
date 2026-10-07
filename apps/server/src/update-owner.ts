/** App bundles are sealed and updated as a unit, never by the tarball updater. */
export function isMacAppManaged(): boolean {
  return process.env.DISPATCH_UPDATE_OWNER === "macos-app";
}

export const MAC_APP_UPDATE_MESSAGE =
  "Click the Dispatch icon in your Mac’s menu bar, then choose Check for Updates. To receive updates automatically, make sure Install Updates Automatically is enabled.";
