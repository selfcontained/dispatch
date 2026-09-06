import { useEffect, useState } from "react";
import {
  HARNESS_USAGE_PROVIDERS,
  type HarnessUsageProviderId,
  type UsageBudgets,
} from "@dispatch/shared";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUsageBudgets } from "@/hooks/use-usage-budgets";

type Row = { id: HarnessUsageProviderId; amount: string };

function labelOf(id: HarnessUsageProviderId): string {
  return HARNESS_USAGE_PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

function rowsFrom(budgets: UsageBudgets): Row[] {
  return HARNESS_USAGE_PROVIDERS.filter((p) => budgets[p.id] !== undefined).map(
    (p) => ({ id: p.id, amount: String(budgets[p.id]) })
  );
}

/**
 * Monthly spend budgets per provider key. Empty until a row is added from
 * the dropdown; a row with an amount gives the usage dialog its bar. A row
 * is saved when its amount is committed (blur or Enter), removed with ×.
 */
export function UsageBudgetSettings(): JSX.Element {
  const { budgets, loaded, save, saving, error } = useUsageBudgets();
  const [rows, setRows] = useState<Row[]>([]);
  // Rows follow the server until the user starts editing; an added row
  // with no amount yet lives only here until it gets one.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setRows(rowsFrom(budgets));
  }, [budgets, dirty]);

  const persist = async (next: Row[]) => {
    const payload: UsageBudgets = {};
    for (const row of next) {
      const amount = Number(row.amount);
      if (Number.isFinite(amount) && amount > 0) payload[row.id] = amount;
    }
    try {
      await save(payload);
      setDirty(false);
    } catch {
      // The hook reports it; the rows stay so nothing typed is lost.
    }
  };

  const available = HARNESS_USAGE_PROVIDERS.filter(
    (p) => !rows.some((r) => r.id === p.id)
  );

  return (
    <div className="p-6" data-testid="usage-budget-settings">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Usage budgets
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        A monthly amount in USD per provider key. The Harness view&apos;s usage
        dialog (<span className="font-terminal">/usage</span>) draws each
        provider&apos;s spend this month against it. No budget, no bar.
      </p>
      <div className="max-w-lg space-y-2">
        {rows.length === 0 && loaded ? (
          <p
            className="rounded border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground"
            data-testid="usage-budget-empty"
          >
            No budgets yet. Add one below.
          </p>
        ) : null}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-3 rounded border border-border px-3 py-2"
            data-testid="usage-budget-row"
            data-provider={row.id}
          >
            <span className="w-24 text-sm font-medium text-foreground">
              {labelOf(row.id)}
            </span>
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="decimal"
              placeholder="per month"
              value={row.amount}
              aria-label={`${labelOf(row.id)} monthly budget in USD`}
              data-testid="usage-budget-amount"
              className="h-8 w-32"
              onChange={(event) => {
                setDirty(true);
                setRows((current) =>
                  current.map((r) =>
                    r.id === row.id ? { ...r, amount: event.target.value } : r
                  )
                );
              }}
              onBlur={() => void persist(rows)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void persist(rows);
                }
              }}
            />
            <span className="text-xs text-muted-foreground">/ month</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto h-7 w-7 text-muted-foreground"
              aria-label={`Remove ${labelOf(row.id)} budget`}
              data-testid="usage-budget-remove"
              onClick={() => {
                const next = rows.filter((r) => r.id !== row.id);
                setDirty(true);
                setRows(next);
                void persist(next);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {available.length > 0 ? (
          <Select
            value=""
            onValueChange={(id) => {
              setDirty(true);
              setRows((current) => [
                ...current,
                { id: id as HarnessUsageProviderId, amount: "" },
              ]);
            }}
          >
            <SelectTrigger
              className="h-8 w-48"
              aria-label="Add a budget"
              data-testid="usage-budget-add"
            >
              <SelectValue placeholder="Add budget…" />
            </SelectTrigger>
            <SelectContent>
              {available.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {saving ? (
          <p className="text-xs text-muted-foreground">Saving…</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
