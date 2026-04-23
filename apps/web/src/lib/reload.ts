type UpdateSW = (reloadPage?: boolean) => Promise<void>;

let updateSW: UpdateSW | null = null;

export function setUpdateSW(fn: UpdateSW): void {
  updateSW = fn;
}

export async function reloadApp(): Promise<void> {
  if (updateSW) {
    try {
      await updateSW(true);
      return;
    } catch {
      // Fall through to a hard reload if the SW update path fails so the
      // user isn't left with a stuck Reload button.
    }
  }
  window.location.reload();
}
