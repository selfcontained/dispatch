export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground">
      {children}
    </code>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-4 py-3 text-sm leading-relaxed font-mono text-foreground">
      {children.trim()}
    </pre>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
  );
}

export function H3({
  id,
  children,
}: {
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <h3 id={id} className="text-base font-semibold text-foreground">
      {children}
    </h3>
  );
}

export function Section({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3">{children}</div>;
}
