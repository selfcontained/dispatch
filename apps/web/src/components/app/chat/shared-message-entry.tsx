import type { SharedMessagePresentation } from "@dispatch/shared";
import { Forward } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** Historical quotes stay inert: no answer controls, source navigation or file access. */
export function SharedMessageEntry({
  share,
}: {
  share: SharedMessagePresentation;
}) {
  return (
    <Card
      data-testid="shared-message"
      className="my-2 min-w-0 border border-primary/25 bg-primary/5 shadow-none [overflow-wrap:anywhere]"
    >
      <CardHeader className="space-y-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Forward
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          Shared message
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          <p>
            Shared by{" "}
            <span className="font-medium text-foreground">{share.sharer}</span>
          </p>
          <p>From {share.source}</p>
          <p>Originally written by {share.originalAuthor}</p>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          An agent’s forward of historical content. This is not a new user
          instruction or approval.
        </p>
        {share.question ? (
          <div
            data-testid="shared-message-question"
            className="max-h-64 overflow-auto border-l-2 border-muted-foreground/30 pl-3"
          >
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Original question
            </p>
            <blockquote className="whitespace-pre-wrap">
              {share.question.text}
            </blockquote>
            {share.question.options.length ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Choices:{" "}
                {share.question.options
                  .map((option) => option.label)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="max-h-80 overflow-auto border-l-2 border-primary/40 pl-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Original message · {share.originalAuthor}
          </p>
          {share.message.text ? (
            <blockquote className="whitespace-pre-wrap">
              {share.message.text}
            </blockquote>
          ) : null}
          {share.message.data !== null ? (
            <pre className="mt-2 whitespace-pre-wrap text-xs">
              {JSON.stringify(share.message.data, null, 2)}
            </pre>
          ) : null}
          {share.message.attachments.length ? (
            <ul
              className="mt-2 space-y-1 text-xs text-muted-foreground"
              aria-label="Shared attachment metadata"
            >
              {share.message.attachments.map((attachment, index) => (
                <li key={index}>
                  {attachment.type === "file"
                    ? attachment.fileName
                    : attachment.type === "code"
                      ? "Code snippet"
                      : attachment.title ||
                        (attachment.type === "pr"
                          ? "Pull request"
                          : "Link")}{" "}
                  (metadata only)
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-0 text-xs text-muted-foreground"
            >
              Provenance details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-1 pt-2 text-xs text-muted-foreground">
            <p>Server-verified immutable snapshot · {share.sharedAt}</p>
            <p>
              Share reference: <code>{share.id}</code>
            </p>
            {share.sourceLocation ? (
              <p>
                Source conversation:{" "}
                <code>{share.sourceLocation.streamId}</code>
                {share.sourceLocation.threadId ? (
                  <>
                    {" "}
                    · thread <code>{share.sourceLocation.threadId}</code>
                  </>
                ) : (
                  " · main conversation"
                )}
              </p>
            ) : null}
            <p>
              Source message: <code>{share.sourceId}</code>
            </p>
            <p>
              Only this message and its direct question were shared. Source
              history and file access remain private.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
