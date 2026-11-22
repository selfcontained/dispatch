export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-sm bg-muted px-1.5 py-0.5 text-code font-mono text-foreground">
      {children}
    </code>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-surface-hover px-4 py-3 text-body-md leading-relaxed font-mono text-foreground">
      {children.trim()}
    </pre>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-body-md leading-relaxed text-muted-foreground">
      {children}
    </p>
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
    <h3 id={id} className="text-heading-md text-foreground">
      {children}
    </h3>
  );
}

export function Section({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3">{children}</div>;
}
