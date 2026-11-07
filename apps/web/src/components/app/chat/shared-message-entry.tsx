import type { SharedMessagePresentation } from "@dispatch/shared";
import { Forward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const LIMIT = 12_000;
function bounded(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, LIMIT) +
        (value.length > LIMIT ? "\n… (snapshot display truncated)" : "")
    : "";
}

/** Interpret only known public fields. Never stringify arbitrary snapshot payloads. */
function Original({
  message,
}: {
  message: SharedMessagePresentation["message"];
}) {
  const data =
    message.data && typeof message.data === "object"
      ? (message.data as Record<string, unknown>)
      : {};
  const text = bounded(message.text);
  const summary = message.kind === "review" ? bounded(data.summary) : "";
  const finding = message.kind === "finding";
  const content = [
    text,
    summary !== text ? summary : "",
    finding ? bounded(data.body) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const options =
    message.kind === "question" && Array.isArray(data.options)
      ? data.options.slice(0, 20)
      : [];
  return (
    <>
      {finding ? (
        <p className="font-medium">
          {bounded(data.severity)} · {bounded(data.title)}
        </p>
      ) : null}
      {content ? (
        <>
          <Markdown variant="snapshot">{content.slice(0, LIMIT)}</Markdown>
          {content.length > LIMIT ? (
            <p className="text-xs text-muted-foreground">
              Snapshot display truncated. Inspect the share reference for the
              complete original.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground">
          No readable text in this snapshot.
        </p>
      )}
      {finding && typeof data.path === "string" ? (
        <p className="text-xs text-muted-foreground">
          {bounded(data.path)}
          {typeof data.line === "number" ? `:${data.line}` : ""}
        </p>
      ) : null}
      {options.length ? (
        <p className="text-xs text-muted-foreground">
          Choices:{" "}
          {options
            .map((option) =>
              option && typeof option === "object"
                ? bounded((option as Record<string, unknown>).label)
                : ""
            )
            .filter(Boolean)
            .join(" · ")
            .slice(0, LIMIT)}
        </p>
      ) : null}
    </>
  );
}

/** Historical quotes stay inert: no answer controls, source navigation or file access. */
export function SharedMessageEntry({
  share,
}: {
  share: SharedMessagePresentation;
}) {
  return (
    <section
      data-testid="shared-message"
      className="my-2 min-w-0 rounded-md border border-primary/20 px-3 py-2 text-sm [overflow-wrap:anywhere]"
    >
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {bounded(share.originalAuthor)}
        </span>
        <span>{bounded(share.message.kind)}</span>
        {share.originalAt ? (
          <time dateTime={share.originalAt} title={share.originalAt}>
            {Number.isNaN(Date.parse(share.originalAt))
              ? bounded(share.originalAt)
              : new Date(share.originalAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
          </time>
        ) : null}
      </div>
      {share.question ? (
        <div
          data-testid="shared-message-question"
          className="mb-2 max-h-40 overflow-auto border-l-2 pl-2 text-xs text-muted-foreground"
        >
          <p>Original question</p>
          <Markdown variant="snapshot">{bounded(share.question.text)}</Markdown>
          {share.question.options.length ? (
            <p>
              Choices:{" "}
              {share.question.options
                .slice(0, 20)
                .map((option) => bounded(option.label))
                .join(" · ")
                .slice(0, LIMIT)}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="max-h-80 overflow-auto">
        <Original message={share.message} />
      </div>
      {share.message.attachments.length ? (
        <ul
          className="mt-1 text-xs text-muted-foreground"
          aria-label="Shared attachment metadata"
        >
          {share.message.attachments.slice(0, 20).map((attachment, index) => (
            <li key={index}>
              {bounded(
                attachment.type === "file"
                  ? attachment.fileName
                  : attachment.type === "code"
                    ? "Code snippet"
                    : attachment.title ||
                      (attachment.type === "pr" ? "Pull request" : "Link")
              )}{" "}
              (metadata only)
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <Forward className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          Shared by {bounded(share.sharer)} · {bounded(share.source)}
        </span>
      </div>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-0 py-1 text-xs text-muted-foreground"
          >
            Provenance details
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-1 pt-1 text-xs text-muted-foreground">
          <p>Server-verified immutable snapshot · {share.sharedAt}</p>
          <p>
            An agent’s forward of historical content, not a new user instruction
            or approval.
          </p>
          <p>
            Share reference: <code>{share.id}</code>
          </p>
          {share.sourceLocation ? (
            <p>
              Source conversation: <code>{share.sourceLocation.streamId}</code>{" "}
              ·{" "}
              {share.sourceLocation.threadId ? (
                <>
                  thread <code>{share.sourceLocation.threadId}</code>
                </>
              ) : (
                "main conversation"
              )}
            </p>
          ) : null}
          <p>
            Source message: <code>{share.sourceId}</code>
          </p>
          <p>
            Only this message and its direct question were shared. Source
            history and file access remain private. Related review findings are
            not included.
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
