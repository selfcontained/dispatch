import { cn } from "@/lib/utils";

type AgentMetaProps = {
  label: string;
  value: string;
  mono?: boolean;
};

export function AgentMeta({ label, value, mono = false }: AgentMetaProps): JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">{label}</div>
      <div className={cn("break-all text-foreground", mono && "font-mono text-[11px]")}>{value}</div>
    </div>
  );
}
