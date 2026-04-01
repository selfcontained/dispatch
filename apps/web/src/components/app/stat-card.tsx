export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="min-w-[7rem] max-w-[14rem] flex-1 basis-[7rem] rounded-md border border-border bg-muted/40 px-2.5 py-2 sm:px-4 sm:py-3">
      <p className="text-[10px] sm:text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 sm:mt-1 text-lg sm:text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] sm:text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
