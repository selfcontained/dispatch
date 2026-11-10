import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import type { Block } from "@dispatch/shared";

/** A system observation, presented separately from authored reviews/approval. */
export function RiskAssessmentEntry({ block }: { block: Block }) {
  const data = (
    block.kind === "text" ? block.data?.pullRequestTransition : undefined
  ) as { headSha?: string; recommendation?: string } | undefined;
  const pr = block.attachments.find((item) => item.type === "pr");
  return (
    <Card className="my-1 gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4 text-muted-foreground" />
          Merge-risk assessment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4 text-sm">
        <p className="font-medium">{data?.recommendation}</p>
        {pr?.type === "pr" && (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-4"
          >
            {pr.title || "View pull request"}
          </a>
        )}
        <p className="break-all text-xs text-muted-foreground">
          Assessed head <code>{data?.headSha}</code>
        </p>
        <p className="text-xs text-muted-foreground">
          Dispatch system · Informational only. Not merge approval or
          authorization.
        </p>
      </CardContent>
    </Card>
  );
}
