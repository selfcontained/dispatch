import { useMemo } from "react";

import { cn } from "@/lib/utils";

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/**
 * Line-aligned diff over the two texts (longest common subsequence). Bounded:
 * past the cell budget it falls back to "everything removed, everything
 * added", which is still honest, just less pretty. A null old text is an
 * empty file, so a new file is pure additions.
 */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const a = oldText === null || oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const CELL_BUDGET = 250_000;
  if (a.length * b.length > CELL_BUDGET) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

const DIFF_LINE_CLASS: Record<DiffLine["kind"], string> = {
  same: "text-muted-foreground",
  add: "bg-status-done/10 text-status-done",
  del: "bg-status-blocked/10 text-status-blocked",
};
const DIFF_SIGN: Record<DiffLine["kind"], string> = {
  same: " ",
  add: "+",
  del: "-",
};

export function DiffBlock({
  oldText,
  newText,
}: {
  oldText: string | null;
  newText: string;
}): JSX.Element {
  // An open diff survives every feed refetch; do not realign it each time.
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <pre
      className="max-h-64 overflow-auto rounded-md bg-muted font-terminal text-[11px] leading-snug"
      data-testid="chat-activity-diff"
    >
      {lines.map((line, index) => (
        <div
          key={index}
          data-kind={line.kind}
          className={cn("flex min-w-0 px-2", DIFF_LINE_CLASS[line.kind])}
        >
          <span aria-hidden="true" className="w-4 shrink-0 select-none">
            {DIFF_SIGN[line.kind]}
          </span>
          <span className="whitespace-pre">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}
