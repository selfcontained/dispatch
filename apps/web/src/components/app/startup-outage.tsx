export function StartupOutage({ error }: { error?: string }): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="max-w-lg space-y-4">
        <p className="text-sm font-semibold uppercase tracking-wider text-amber-500">
          Dispatch is unavailable
        </p>
        <h1 className="text-3xl font-semibold">Waiting for the database</h1>
        <p className="text-muted-foreground">
          Dispatch is retrying its database connection. This page will recover
          automatically when the service is ready.
        </p>
        {error && (
          <p className="rounded-md bg-muted p-3 font-mono text-sm">{error}</p>
        )}
      </section>
    </main>
  );
}
