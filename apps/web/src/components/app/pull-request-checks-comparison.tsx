import { PullRequestRow } from "./agent-pull-requests";
import { previewPullRequests } from "./agent-pull-requests.preview";

const variants = [
  {
    id: "original",
    title: "A · Original",
    description: "Thin segmented ring and original X.",
  },
  {
    id: "ring",
    title: "B · Thicker ring",
    description: "Thicker segmented ring; original X size and weight.",
  },
  {
    id: "both",
    title: "C · Thicker ring + heavier X",
    description:
      "Thicker segmented ring; nearly original-size X with heavier strokes.",
  },
  {
    id: "solid",
    title: "D · Solid failure ring + heavier X",
    description:
      "Solid red failure ring; nearly original-size X with heavier strokes.",
  },
];

/** Design Lab fixtures rendered by the production row, including its popover. */
export function PullRequestChecksComparison() {
  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">PR check icon comparison</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Real sidebar components at their actual size, using the same sample
          checks in every option. Compare the failed PR1381 row. Click any
          status icon to open its real checks popover. Passing and pending icons
          remain unchanged.
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-2">
        {variants.map((variant) => (
          <article
            key={variant.id}
            className="rounded-lg border border-border p-4"
          >
            <h2 className="text-sm font-semibold">{variant.title}</h2>
            <p className="mt-1 min-h-10 text-xs text-muted-foreground">
              {variant.description}
            </p>
            <div className="mt-4 w-full max-w-72 rounded-lg border border-border bg-sidebar p-3">
              <p className="mb-3 text-xs font-medium">theme polish</p>
              {previewPullRequests.slice(0, 3).map((pr) => (
                <PullRequestRow
                  key={pr.url}
                  pr={pr}
                  failureStyle={variant.id}
                  isError={false}
                  onDismiss={() => {}}
                />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
