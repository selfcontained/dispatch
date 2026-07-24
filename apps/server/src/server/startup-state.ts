export type StartupState = "initializing" | "ready" | "database_unavailable";

export class StartupStateStore {
  private state: StartupState = "initializing";
  private error: string | null = null;

  setReady(): void {
    this.state = "ready";
    this.error = null;
  }

  setDatabaseUnavailable(error: string): void {
    this.state = "database_unavailable";
    this.error = error;
  }

  snapshot(): { state: StartupState; error: string | null } {
    return { state: this.state, error: this.error };
  }

  isReady(): boolean {
    return this.state === "ready";
  }
}
