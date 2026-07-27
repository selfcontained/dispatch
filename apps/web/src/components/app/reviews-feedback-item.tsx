import { useCallback, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";

import {
  useAddReviewThreadMessage,
  useSetReviewFeedbackResolution,
  type ReviewFeedbackItem,
  type ReviewThreadMessage,
} from "@/hooks/use-agent-reviews";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/ui/markdown";
import { ReviewDiffSnapshot } from "@/components/app/review-diff-snapshot";
import {
  FeedbackReplyForm,
  FeedbackResolutionFooter,
  type FeedbackState,
} from "@/components/app/feedback-card-parts";

function feedbackState(item: ReviewFeedbackItem): FeedbackState {
  if (item.status !== "resolved") return "open";
  if (item.resolution === "fixed") return "fixed";
  return "dismissed";
}

function formatFilePath(
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null
): string {
  let label = filePath;
  if (lineStart) {
    label += `:${lineStart}`;
    if (lineEnd && lineEnd !== lineStart) label += `–${lineEnd}`;
  }
  return label;
}

function compactFilePath(
  filePath: string,
  lineStart: number | null,
  lineEnd: number | null
): string {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  return formatFilePath(fileName, lineStart, lineEnd);
}

export function FeedbackItemRow({
  agentId,
  item,
  onNavigateToFile,
  diffFilePaths,
}: {
  agentId: string;
  item: ReviewFeedbackItem;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
  diffFilePaths?: Set<string>;
}): JSX.Element {
  const state = feedbackState(item);
  const [expanded, setExpanded] = useState(false);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const addMessage = useAddReviewThreadMessage(agentId);
  const setResolution = useSetReviewFeedbackResolution(agentId);

  const fileInDiff =
    !diffFilePaths || !item.filePath || diffFilePaths.has(item.filePath);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (item.filePath && onNavigateToFile && fileInDiff) {
        onNavigateToFile(item.filePath, item.lineStart, item.id);
      }
    },
    [item, onNavigateToFile, fileInDiff]
  );

  const fullPathLabel = item.filePath
    ? formatFilePath(item.filePath, item.lineStart, item.lineEnd)
    : null;
  const compactPathLabel = item.filePath
    ? compactFilePath(item.filePath, item.lineStart, item.lineEnd)
    : null;
  const originalFeedback = item.messages[0]?.content?.body ?? "Feedback item";

  const stateIcon =
    state === "fixed" ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-working" />
    ) : state === "dismissed" ? (
      <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Circle className="h-3.5 w-3.5 shrink-0 text-status-waiting" />
    );
  const stateLabel =
    state === "fixed" ? "Fixed" : state === "dismissed" ? "Dismissed" : "Open";

  const submitReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body) return;
    try {
      await addMessage.mutateAsync({ itemId: item.id, body });
      setReply("");
      setReplying(false);
    } catch {
      toast.error("Couldn't send the reply. Try again.");
    }
  };

  const cancelReply = () => {
    setReply("");
    setReplying(false);
  };

  const updateResolution = async (resolution: "fixed" | "dismissed" | null) => {
    try {
      await setResolution.mutateAsync({ itemId: item.id, resolution });
    } catch {
      toast.error("Couldn't update the feedback state. Try again.");
    }
  };

  return (
    <div className="ml-1 pb-2 last:pb-0">
      <div
        className={cn(
          "group relative rounded-md bg-muted/15 text-left",
          !expanded && "transition-colors hover:bg-muted/35",
          expanded && "sticky top-[49px] z-10 rounded-b-none bg-card shadow-sm"
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} feedback`}
          className="flex min-h-11 w-full items-center gap-2 rounded-md border border-primary/50 bg-card px-2.5 py-2.5 text-left transition-colors hover:border-primary/80 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">{stateIcon}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{stateLabel}</TooltipContent>
          </Tooltip>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
            Feedback · {stateLabel}
          </span>
          {compactPathLabel && (
            <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted-foreground">
              {compactPathLabel}
            </span>
          )}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeInOut" }}
            className="overflow-clip"
          >
            <div className="ml-5 border-l border-border/70 bg-muted/[0.1] px-3 pb-3 pt-2.5">
              {fullPathLabel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {fileInDiff ? (
                      <button
                        type="button"
                        className="mb-2 block w-full truncate text-left font-mono text-[10px] text-primary hover:underline [direction:rtl]"
                        onClick={handleFileClick}
                      >
                        {fullPathLabel}
                      </button>
                    ) : (
                      <p className="mb-2 w-full truncate text-left font-mono text-[10px] text-muted-foreground [direction:rtl]">
                        {fullPathLabel}
                      </p>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-xs">
                    <p className="font-mono text-xs break-all">
                      {fullPathLabel}
                      {!fileInDiff && (
                        <span className="ml-1 text-muted-foreground">
                          (not in current diff)
                        </span>
                      )}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
              <div
                data-testid={`feedback-description-${item.id}`}
                className="mb-3 select-text rounded-md bg-muted/20 px-3 py-2.5 text-xs leading-[1.45] text-foreground/90"
              >
                <Markdown
                  className={cn(
                    "text-xs leading-[1.45] text-foreground/90",
                    "prose-p:my-0 prose-ul:my-0 prose-ol:my-0 prose-li:my-0",
                    "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  )}
                >
                  {originalFeedback}
                </Markdown>
              </div>
              {item.diffSnapshot && (
                <ReviewDiffSnapshot diff={item.diffSnapshot} className="mt-0" />
              )}
              {item.messages.slice(1).map((message, index, messages) => (
                <ThreadMessage
                  key={message.id}
                  message={message}
                  grouped={
                    index > 0 &&
                    messages[index - 1]?.authorType === message.authorType &&
                    messages[index - 1]?.type === message.type
                  }
                />
              ))}
              <FeedbackReplyForm
                replying={replying}
                reply={reply}
                isPending={addMessage.isPending}
                variant="sidebar"
                onReplyChange={setReply}
                onStartReply={() => setReplying(true)}
                onCancelReply={cancelReply}
                onSubmit={submitReply}
              />
            </div>
            <FeedbackResolutionFooter
              state={state}
              resolution={item.resolution}
              resolutionNote={item.resolutionNote}
              isPending={setResolution.isPending}
              pendingResolution={setResolution.variables?.resolution}
              variant="sidebar"
              onUpdateResolution={(resolution) =>
                void updateResolution(resolution)
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThreadMessage({
  message,
  grouped,
}: {
  message: ReviewThreadMessage;
  grouped: boolean;
}): JSX.Element {
  const isAgent = message.authorType !== "human";
  const isStateChange =
    message.type === "resolution" || message.type === "reopen";
  const stateChangeLabel =
    message.type === "reopen"
      ? "Reopened feedback"
      : message.content?.resolution
        ? `Marked ${message.content.resolution}`
        : "Updated feedback state";
  const body = isStateChange
    ? message.content?.body
      ? `${stateChangeLabel}\n\n${message.content.body}`
      : stateChangeLabel
    : message.content?.body || "Updated feedback";
  return (
    <div className={cn(grouped ? "mt-1" : "mt-2.5", isAgent ? "pr-6" : "pl-6")}>
      {!grouped && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-[10px] text-muted-foreground/75",
            !isAgent && "justify-end"
          )}
        >
          <span className="font-medium">
            {isStateChange ? "State change" : isAgent ? "Agent" : "You"}
          </span>
          <span>·</span>
          <span>
            {new Date(message.createdAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}
      <div
        className={cn(
          !grouped && "mt-0.5",
          "rounded-xl px-2.5 py-1.5",
          isStateChange
            ? "rounded-md border border-border/70 bg-muted/30 text-muted-foreground"
            : isAgent
              ? "rounded-bl-sm bg-muted text-foreground"
              : "rounded-br-sm bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20"
        )}
      >
        <Markdown className="text-xs text-foreground">{body}</Markdown>
      </div>
    </div>
  );
}
