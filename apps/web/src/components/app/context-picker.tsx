import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { panelFrame } from "@/components/ui/card";
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
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";
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
      <RowButton
        onClick={onAddFile}
        className="rounded-sm px-2 py-1.5 text-body-md text-foreground hover:bg-fill-hover"
      >
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
        Add file
      </RowButton>
      <RowButton
        onClick={onAddLink}
        className="rounded-sm px-2 py-1.5 text-body-md text-foreground hover:bg-fill-hover"
      >
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        Add link
      </RowButton>
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
      <label
        htmlFor={inputId}
        className="text-body-sm font-medium text-foreground"
      >
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
          className="text-body-sm text-danger"
          {...(testIdPrefix
            ? { "data-testid": `${testIdPrefix}-link-error` }
            : {})}
        >
          Enter a valid `http:` or `https:` URL.
        </p>
      ) : null}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft />
          Back
        </Button>
        <Button
          type="button"
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
  error?: string | null;
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
  error,
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
        panelFrame,
        "space-y-3 p-3 transition-colors",
        draggingFiles &&
          "border-info/line bg-info/tint ring-1 ring-inset ring-info/line",
        className
      )}
      onPaste={handleRootPaste}
      {...(testIdPrefix ? { "data-testid": testIdPrefix } : {})}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-body-md font-medium text-foreground">
            <Paperclip className="h-3.5 w-3.5" />
            Context
          </div>
          <p className="text-body-sm text-muted-foreground">{description}</p>
        </div>
        {clipboard.pasteMode ? (
          <div className="relative shrink-0">
            <input
              ref={clipboard.pasteRef}
              type="text"
              placeholder="Paste here"
              className="h-7 w-32 rounded-md border border-border-subtle bg-background/veil px-2 text-body-sm placeholder:text-muted-foreground focus-ring"
              onPaste={clipboard.handlePasteInput}
              onBlur={clipboard.handlePasteBlur}
            />
            {clipboard.pasteTooltip ? (
              <div
                className="absolute right-0 top-full z-drawer mt-1.5 whitespace-nowrap rounded-md border bg-popover px-2 py-1.5 text-body-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                role="status"
              >
                {clipboard.pasteTooltip}
              </div>
            ) : null}
          </div>
        ) : (
          <Button
            type="button"
            size="xs"
            className="shrink-0"
            onClick={clipboard.handleCheck}
            disabled={clipboard.checking}
            {...(testIdPrefix
              ? { "data-testid": `${testIdPrefix}-clipboard-action` }
              : {})}
          >
            {clipboard.checking ? <Spinner /> : <Clipboard />}
            Read clipboard
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {clipboard.readFeedback ? (
        <p
          className="text-body-sm text-muted-foreground"
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
            <RowButton
              {...(testIdPrefix
                ? { "data-testid": `${testIdPrefix}-files-button` }
                : {})}
              className={cn(
                "flex-col justify-center gap-1.5 border border-dashed px-4 py-6 text-body-md",
                draggingFiles
                  ? "border-info bg-info/tint text-foreground hover:bg-info/tint"
                  : "border-border-subtle bg-background/veil text-muted-foreground hover:border-border hover:bg-background/soft hover:text-foreground"
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
                  <span className="text-label-sm text-faint">
                    Click to add, or drop a file here
                  </span>
                </>
              )}
            </RowButton>
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
              <Hint label="Add context">
                <RowButton
                  aria-label="Add context"
                  {...(testIdPrefix
                    ? { "data-testid": `${testIdPrefix}-files-button` }
                    : {})}
                  className={cn(
                    "h-12 w-12 justify-center border border-dashed",
                    draggingFiles
                      ? "border-info bg-info/tint text-foreground hover:bg-info/tint"
                      : "border-border-subtle bg-background/veil text-muted-foreground hover:border-border hover:bg-background/soft hover:text-foreground"
                  )}
                >
                  {draggingFiles ? (
                    <Upload className="h-4 w-4" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                </RowButton>
              </Hint>
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
