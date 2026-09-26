/** App bundles are sealed and updated as a unit, never by the tarball updater. */
export function isMacAppManaged(): boolean {
  return process.env.DISPATCH_UPDATE_OWNER === "macos-app";
}

export const MAC_APP_UPDATE_MESSAGE =
  "This server is managed by Dispatch Preview for macOS. Web updates and assisted-update agents are disabled. Finish active agents, stop the server from its menu, and replace the app to update this preview.";
