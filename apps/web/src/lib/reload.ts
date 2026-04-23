type UpdateSW = (reloadPage?: boolean) => Promise<void>;

let updateSW: UpdateSW | null = null;

export function setUpdateSW(fn: UpdateSW): void {
  updateSW = fn;
}

export function reloadApp(): void {
  if (updateSW) {
    void updateSW(true);
    return;
  }
  window.location.reload();
}
