import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  Clipboard,
  Link2,
  Paperclip,
  Plus,
  Upload,
} from "lucide-react";

import {
  STARTUP_FILE_ACCEPT,
  normalizeUrl,
  startupFileKey,
} from "@/components/app/create-agent-dialog-clipboard";
import {
  ContextFileItem,
  ContextLinkItem,
} from "@/components/app/context-picker-items";
import { useContextPickerClipboard } from "@/components/app/use-context-picker-clipboard";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function AddContextMenu({
  onAddFile,
  onAddLink,
}: {
  onAddFile: () => void;
  onAddLink: () => void;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onAddFile}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
        Add file
      </button>
      <button
        type="button"
        onClick={onAddLink}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-white/[0.1]"
      >
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        Add link
      </button>
    </div>
  );
}

function AddContextLinkForm({
  value,
  onChange,
  onSubmit,
  onBack,
  isValid,
  inputId,
  errorId,
  testIdPrefix,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  isValid: boolean;
  inputId: string;
  errorId: string;
  testIdPrefix?: string;
}) {
  return (
    <div className="space-y-1.5 p-1">
      <label htmlFor={inputId} className="text-xs text-muted-foreground">
        Link URL
      </label>
      <Input
        id={inputId}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (value.trim().length > 0 && isValid) {
              onSubmit();
            }
          }
        }}
        placeholder="https://..."
        aria-invalid={!isValid}
        aria-describedby={!isValid ? errorId : undefined}
        {...(testIdPrefix
          ? { "data-testid": `${testIdPrefix}-link-input` }
          : {})}
      />
      {!isValid ? (
        <p
          id={errorId}
          className="text-xs text-status-blocked"
          {...(testIdPrefix
            ? { "data-testid": `${testIdPrefix}-link-error` }
            : {})}
        >
          Enter a valid `http:` or `https:` URL.
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-1 h-3 w-3" />
          Back
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onSubmit}
          disabled={value.trim().length === 0 || !isValid}
          {...(testIdPrefix
            ? { "data-testid": `${testIdPrefix}-link-add` }
            : {})}
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

export type ContextPickerProps = {
  files: File[];
  links: string[];
  draggingFiles: boolean;
  filePreviewsRef: React.MutableRefObject<Map<string, string>>;
  onAppendFiles: (files: File[]) => void;
  onRemoveFile: (file: File) => void;
  onAddLink: (normalizedUrl: string) => void;
  onRemoveLink: (link: string) => void;
  onClipboardText?: (text: string) => void;
  onDraftInvalid?: (hasInvalidDraft: boolean) => void;
  description?: string;
  className?: string;
  testIdPrefix?: string;
};

export function ContextPicker({
  files,
  links,
  draggingFiles,
  filePreviewsRef,
  onAppendFiles,
  onRemoveFile,
  onAddLink,
  onRemoveLink,
  onClipboardText,
  onDraftInvalid,
  description = "Attach files or links.",
  className,
  testIdPrefix,
}: ContextPickerProps) {
  const autoId = useId();
  const linkInputId = testIdPrefix
    ? `${testIdPrefix}-link-input`
    : `${autoId}-link-input`;
  const linkErrorId = testIdPrefix
    ? `${testIdPrefix}-link-error`
    : `${autoId}-link-error`;

  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [linkDraft, setLinkDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"menu" | "link">("menu");

  const clipboard = useContextPickerClipboard({
    onAppendFiles,
    onAddLink,
    onClipboardText,
  });
  const { handlePaste: clipboardHandlePaste } = clipboard;

  const hasContextItems = files.length > 0 || links.length > 0;

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      onAppendFiles(selected);
      event.target.value = "";
    },
    [onAppendFiles]
  );

  const handleRootPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        return;
      clipboardHandlePaste(event);
    },
    [clipboardHandlePaste]
  );

  const handleAddOpenChange = useCallback((next: boolean) => {
    setAddOpen(next);
    if (!next) {
      setAddMode("menu");
      setLinkDraft("");
    }
  }, []);

  const handleAddFileFromMenu = useCallback(() => {
    setAddOpen(false);
    setAddMode("menu");
    requestAnimationFrame(() => fileInputRef.current?.click());
  }, []);

  const handleAddLinkFromMenu = useCallback(() => {
    setAddMode("link");
  }, []);

  const handleAddLinkBack = useCallback(() => {
    setLinkDraft("");
    setAddMode("menu");
  }, []);

  const normalizedLinkDraft = normalizeUrl(linkDraft);
  const linkDraftIsValid =
    linkDraft.trim().length === 0 || normalizedLinkDraft !== null;

  useEffect(() => {
    onDraftInvalid?.(linkDraft.trim().length > 0 && !linkDraftIsValid);
  }, [linkDraft, linkDraftIsValid, onDraftInvalid]);

  const handleAddLinkSubmit = useCallback(() => {
    if (!normalizedLinkDraft) return;
    onAddLink(normalizedLinkDraft);
    setLinkDraft("");
    setAddMode("menu");
    setAddOpen(false);
  }, [normalizedLinkDraft, onAddLink]);

  const popoverContent =
    addMode === "menu" ? (
      <AddContextMenu
        onAddFile={handleAddFileFromMenu}
        onAddLink={handleAddLinkFromMenu}
      />
    ) : (
      <AddContextLinkForm
        value={linkDraft}
        onChange={setLinkDraft}
        onSubmit={handleAddLinkSubmit}
        onBack={handleAddLinkBack}
        isValid={linkDraftIsValid}
        inputId={linkInputId}
        errorId={linkErrorId}
        testIdPrefix={testIdPrefix}
      />
    );

  return (
    <div
      ref={rootRef}
      className={cn(
        "space-y-3 rounded-md border bg-muted/20 px-3 py-3 transition-colors",
        draggingFiles
          ? "border-status-done/35 bg-status-done/8 ring-1 ring-inset ring-status-done/30"
          : "border-border/70",
        className
      )}
      onPaste={handleRootPaste}
      {...(testIdPrefix ? { "data-testid": testIdPrefix } : {})}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Paperclip className="h-3.5 w-3.5" />
            Context
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {clipboard.pasteMode ? (
          <div className="relative shrink-0">
            <input
              ref={clipboard.pasteRef}
              type="text"
              placeholder="Paste here"
              className="h-7 w-32 rounded-md border border-border/70 bg-background/40 px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onPaste={clipboard.handlePasteInput}
              onBlur={clipboard.handlePasteBlur}
            />
            {clipboard.pasteTooltip ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                role="status"
              >
                {clipboard.pasteTooltip}
              </div>
            ) : null}
          </div>
        ) : (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={clipboard.handleCheck}
            disabled={clipboard.checking}
            {...(testIdPrefix
              ? { "data-testid": `${testIdPrefix}-clipboard-action` }
              : {})}
          >
            {clipboard.checking ? (
              <ActivityBars size={12} className="mr-0.5" />
            ) : (
              <Clipboard className="h-3 w-3" />
            )}
            Read clipboard
          </Button>
        )}
      </div>
      {clipboard.readFeedback ? (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          {...(testIdPrefix
            ? { "data-testid": `${testIdPrefix}-clipboard-feedback` }
            : {})}
        >
          {clipboard.readFeedback}
        </p>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={STARTUP_FILE_ACCEPT}
        className="hidden"
        onChange={handleFileChange}
        {...(testIdPrefix
          ? { "data-testid": `${testIdPrefix}-files-input` }
          : {})}
      />
      {!hasContextItems ? (
        <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...(testIdPrefix
                ? { "data-testid": `${testIdPrefix}-files-button` }
                : {})}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-6 text-sm transition-colors",
                draggingFiles
                  ? "border-status-done bg-status-done/10 text-foreground"
                  : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
              )}
            >
              {draggingFiles ? (
                <>
                  <Upload className="h-5 w-5" />
                  <span>Drop file to add</span>
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5" />
                  <span>Add files or links</span>
                  <span className="text-[11px] text-muted-foreground/80">
                    Click to add, or drop a file here
                  </span>
                </>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1">
            {popoverContent}
          </PopoverContent>
        </Popover>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {files.map((file) => (
            <ContextFileItem
              key={startupFileKey(file)}
              file={file}
              preview={filePreviewsRef.current.get(startupFileKey(file))}
              onRemove={() => onRemoveFile(file)}
            />
          ))}
          {links.map((link) => (
            <ContextLinkItem
              key={link}
              link={link}
              onRemove={() => onRemoveLink(link)}
            />
          ))}
          <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Add context"
                {...(testIdPrefix
                  ? { "data-testid": `${testIdPrefix}-files-button` }
                  : {})}
                className={cn(
                  "flex h-12 w-12 items-center justify-center rounded-md border border-dashed transition-colors",
                  draggingFiles
                    ? "border-status-done bg-status-done/10 text-foreground"
                    : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                )}
              >
                {draggingFiles ? (
                  <Upload className="h-4 w-4" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-1">
              {popoverContent}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
