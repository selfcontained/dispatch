import {
  type ChangeEvent,
  type ClipboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  Clipboard,
  FileText,
  Link2,
  Paperclip,
  Plus,
  Upload,
  X,
} from "lucide-react";

import {
  type ClipboardSuggestion,
  STARTUP_FILE_ACCEPT,
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
  getClipboardSuggestion,
  normalizeUrl,
  startupFileExt,
  startupFileKey,
  startupLinkLabel,
} from "@/components/app/create-agent-dialog-clipboard";
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
  const clipboardRequestIdRef = useRef(0);
  const clipboardPasteRef = useRef<HTMLInputElement>(null);
  const pasteTooltipTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const [linkDraft, setLinkDraft] = useState("");
  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [clipboardPasteMode, setClipboardPasteMode] = useState(false);
  const [pasteTooltip, setPasteTooltip] = useState<string | null>(null);
  const [clipboardReadFeedback, setClipboardReadFeedback] = useState<
    string | null
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"menu" | "link">("menu");

  const hasContextItems = files.length > 0 || links.length > 0;

  const applyClipboardSuggestion = useCallback(
    (suggestion: ClipboardSuggestion) => {
      switch (suggestion.kind) {
        case "image":
        case "file":
          onAppendFiles([suggestion.file]);
          break;
        case "url":
          onAddLink(suggestion.url);
          break;
        case "text":
          onClipboardText?.(suggestion.text);
          break;
      }
    },
    [onAppendFiles, onAddLink, onClipboardText]
  );

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    setClipboardReadFeedback(null);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      if (result.suggestion) {
        if (result.suggestion.kind === "text" && !onClipboardText) {
          setClipboardReadFeedback("Nothing readable found on the clipboard.");
        } else {
          applyClipboardSuggestion(result.suggestion);
        }
        return;
      }
      if (result.status === "blocked" || result.status === "unsupported") {
        setClipboardPasteMode(true);
        requestAnimationFrame(() => clipboardPasteRef.current?.focus());
      } else {
        setClipboardReadFeedback("Nothing readable found on the clipboard.");
      }
    });
  }, [applyClipboardSuggestion, onClipboardText]);

  const handleClipboardPasteInput = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        onAppendFiles(pastedFiles);
        setClipboardPasteMode(false);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        applyClipboardSuggestion(textSuggestion);
        setClipboardPasteMode(false);
        return;
      }
      if (onClipboardText && textSuggestion?.kind === "text") {
        onClipboardText(textSuggestion.text);
        setClipboardPasteMode(false);
        return;
      }
      clearTimeout(pasteTooltipTimerRef.current);
      setPasteTooltip("No files or images found");
      pasteTooltipTimerRef.current = setTimeout(
        () => setPasteTooltip(null),
        2500
      );
    },
    [onAppendFiles, applyClipboardSuggestion, onClipboardText]
  );

  const handleClipboardPasteBlur = useCallback(() => {
    setClipboardPasteMode(false);
    setPasteTooltip(null);
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      onAppendFiles(selected);
      event.target.value = "";
    },
    [onAppendFiles]
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        return;
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        onAppendFiles(pastedFiles);
        setClipboardReadFeedback(null);
        return;
      }
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        applyClipboardSuggestion(textSuggestion);
        setClipboardReadFeedback(null);
      }
    },
    [onAppendFiles, applyClipboardSuggestion]
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
      onPaste={handlePaste}
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
        {clipboardPasteMode ? (
          <div className="relative shrink-0">
            <input
              ref={clipboardPasteRef}
              type="text"
              placeholder="Paste here"
              className="h-7 w-32 rounded-md border border-border/70 bg-background/40 px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onPaste={handleClipboardPasteInput}
              onBlur={handleClipboardPasteBlur}
            />
            {pasteTooltip ? (
              <div
                className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                role="status"
              >
                {pasteTooltip}
              </div>
            ) : null}
          </div>
        ) : (
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={handleCheckClipboard}
            disabled={checkingClipboard}
            {...(testIdPrefix
              ? { "data-testid": `${testIdPrefix}-clipboard-action` }
              : {})}
          >
            {checkingClipboard ? (
              <ActivityBars size={12} className="mr-0.5" />
            ) : (
              <Clipboard className="h-3 w-3" />
            )}
            Read clipboard
          </Button>
        )}
      </div>
      {clipboardReadFeedback ? (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
          {...(testIdPrefix
            ? { "data-testid": `${testIdPrefix}-clipboard-feedback` }
            : {})}
        >
          {clipboardReadFeedback}
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
            {addMode === "menu" ? (
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
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          {files.map((file) => {
            const key = startupFileKey(file);
            const preview = filePreviewsRef.current.get(key);
            return (
              <div key={key} className="group flex w-12 flex-col gap-0.5">
                <div className="relative h-12 w-12 overflow-hidden rounded-md border border-border/70 bg-muted/40">
                  {preview ? (
                    <img
                      src={preview}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
                      <FileText className="h-3.5 w-3.5" />
                      <span className="text-[8px] font-medium tracking-wide">
                        {startupFileExt(file.name)}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                    onClick={() => onRemoveFile(file)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <span className="rounded-full border border-border/70 bg-background p-0.5">
                      <X className="h-2.5 w-2.5" />
                    </span>
                  </button>
                </div>
                <span
                  className="w-full truncate text-[8px] leading-tight text-muted-foreground"
                  title={file.name}
                >
                  {file.name}
                </span>
              </div>
            );
          })}
          {links.map((link) => {
            const { host, rest } = startupLinkLabel(link);
            return (
              <div
                key={link}
                className="group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight"
                title={link}
              >
                <div className="flex items-center gap-1 text-[10px] text-foreground">
                  <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{host}</span>
                </div>
                {rest ? (
                  <span className="truncate text-[9px] text-muted-foreground">
                    {rest}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                  onClick={() => onRemoveLink(link)}
                  aria-label={`Remove ${link}`}
                >
                  <span className="rounded-full border border-border/70 bg-background p-0.5">
                    <X className="h-2.5 w-2.5" />
                  </span>
                </button>
              </div>
            );
          })}
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
              {addMode === "menu" ? (
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
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
