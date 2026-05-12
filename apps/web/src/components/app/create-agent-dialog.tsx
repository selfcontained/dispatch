import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAtom } from "jotai";
import {
  Check,
  ChevronDown,
  Clipboard,
  ChevronLeft,
  FileText,
  GitBranch,
  Link2,
  Plus,
  Upload,
  X,
} from "lucide-react";

import { BranchSelect } from "@/components/app/branch-select";
import { PathInput } from "@/components/app/path-input";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type Agent } from "@/components/app/types";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  isAgentType,
} from "@/lib/agent-types";
import { api } from "@/lib/api";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { createNewBranchPrefAtom } from "@/lib/store";
import { cn } from "@/lib/utils";

const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
const CWD_HISTORY_KEY = "dispatch:cwdHistory";
const CWD_HISTORY_MAX = 20;
const FULL_ACCESS_PREFIX = "dispatch:fullAccess:";
const AUTO_REVIEW_PREFIX = "dispatch:autoReview:";
const BASE_BRANCH_PREFIX = "dispatch:baseBranch:";
const CONTEXT_PROMPT_ID = "create-agent-context-prompt";
const CONTEXT_LINK_INPUT_ID = "create-agent-context-link-input";
const CONTEXT_LINK_ERROR_ID = "create-agent-context-link-error";

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
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  isValid: boolean;
}) {
  return (
    <div className="space-y-1.5 p-1">
      <label
        htmlFor={CONTEXT_LINK_INPUT_ID}
        className="text-xs text-muted-foreground"
      >
        Link URL
      </label>
      <Input
        id={CONTEXT_LINK_INPUT_ID}
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
        data-testid="create-agent-context-link-input"
        aria-invalid={!isValid}
        aria-describedby={!isValid ? CONTEXT_LINK_ERROR_ID : undefined}
      />
      {!isValid ? (
        <p
          id={CONTEXT_LINK_ERROR_ID}
          className="text-xs text-status-blocked"
          data-testid="create-agent-context-link-error"
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
          data-testid="create-agent-context-link-add"
        >
          Add link
        </Button>
      </div>
    </div>
  );
}

function readStoredString(key: string): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key)?.trim() ?? "";
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

function readLastUsedCwd(): string {
  return readStoredString(LAST_USED_CWD_KEY) || "~/";
}

function readLastUsedAgentType(): AgentType | null {
  const stored = readStoredString(LAST_USED_TYPE_KEY);
  return stored && isAgentType(stored) ? stored : null;
}

function readCwdHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CWD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeCwdHistory(nextHistory: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(nextHistory));
}

function addToCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return readCwdHistory();
  const existing = readCwdHistory().filter((entry) => entry !== trimmed);
  const updated = [trimmed, ...existing].slice(0, CWD_HISTORY_MAX);
  writeCwdHistory(updated);
  return updated;
}

function removeCwdFromHistory(cwd: string): string[] {
  const next = readCwdHistory().filter((entry) => entry !== cwd);
  writeCwdHistory(next);
  return next;
}

function useCreateAgentPrefs(cwd: string) {
  const trimmedCwd = cwd.trim();
  const [fullAccess, setFullAccess] = useState(false);
  const [autoReview, setAutoReview] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");

  // createNewBranch is per-cwd persisted via a jotai atomFamily — the atom's
  // identity changes with cwd, so reads/writes route to the correct
  // localStorage entry without manual load/write effects.
  const createNewBranchAtom = useMemo(
    () => createNewBranchPrefAtom(trimmedCwd),
    [trimmedCwd]
  );
  const [createNewBranch, setCreateNewBranch] = useAtom(createNewBranchAtom);

  useEffect(() => {
    if (!trimmedCwd) {
      setFullAccess(false);
      setAutoReview(false);
      setBaseBranch("main");
      return;
    }
    setFullAccess(
      readStoredBoolean(`${FULL_ACCESS_PREFIX}${trimmedCwd}`, false)
    );
    setAutoReview(
      readStoredBoolean(`${AUTO_REVIEW_PREFIX}${trimmedCwd}`, false)
    );
    setBaseBranch(
      readStoredString(`${BASE_BRANCH_PREFIX}${trimmedCwd}`) || "main"
    );
  }, [trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${FULL_ACCESS_PREFIX}${trimmedCwd}`,
      String(fullAccess)
    );
  }, [fullAccess, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${AUTO_REVIEW_PREFIX}${trimmedCwd}`,
      String(autoReview)
    );
  }, [autoReview, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${BASE_BRANCH_PREFIX}${trimmedCwd}`,
      baseBranch
    );
  }, [baseBranch, trimmedCwd]);

  return {
    fullAccess,
    setFullAccess,
    autoReview,
    setAutoReview,
    baseBranch,
    setBaseBranch,
    createNewBranch,
    setCreateNewBranch,
  };
}

type CreateAgentDialogProps = {
  open: boolean;
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  setOpen: (open: boolean) => void;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
};

export function CreateAgentDialog({
  open,
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: CreateAgentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <CreateAgentDialogContent
          enabledAgentTypes={enabledAgentTypes}
          initialAgentType={initialAgentType}
          setOpen={setOpen}
          resolveDefaultCwd={resolveDefaultCwd}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  );
}

function CreateAgentDialogContent({
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
}: Omit<CreateAgentDialogProps, "open">): JSX.Element {
  const [step, setStep] = useState<"config" | "context">("config");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const startupFileInputRef = useRef<HTMLInputElement>(null);
  const clipboardRequestIdRef = useRef(0);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<AgentType>(() => {
    const preferred = initialAgentType ?? readLastUsedAgentType();
    return preferred && enabledAgentTypes.includes(preferred)
      ? preferred
      : (enabledAgentTypes[0] ?? "codex");
  });
  const [createCwd, setCreateCwd] = useState(() => {
    const resolved = resolveDefaultCwd().trim();
    return resolved || readLastUsedCwd();
  });
  const [createCwdInitialized, setCreateCwdInitialized] = useState(
    () => createCwd.trim().length > 0
  );
  const [createUseWorktree, setCreateUseWorktree] = useState(true);
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [cwdIsGitRepo, setCwdIsGitRepo] = useState<boolean | null>(null);
  const cwdPathInfoRef = useRef<{ isGitRepo: boolean } | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [clipboardReadFeedback, setClipboardReadFeedback] = useState<
    string | null
  >(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [creating, setCreating] = useState(false);
  const [cwdHistory, setCwdHistory] = useState<string[]>(() =>
    readCwdHistory()
  );
  const {
    fullAccess: createFullAccess,
    setFullAccess: setCreateFullAccess,
    autoReview: createAutoReview,
    setAutoReview: setCreateAutoReview,
    baseBranch: createBaseBranch,
    setBaseBranch: setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
  } = useCreateAgentPrefs(createCwd);

  // The new-branch name is per-cwd in spirit (a branch named "repo-A-feature"
  // doesn't make sense in repo B); clear it whenever cwd changes so a name
  // typed for one repo doesn't leak into another.
  useEffect(() => {
    setCreateWorktreeBranch("");
  }, [createCwd]);

  useEffect(() => {
    if (createCwdInitialized) return;
    let cancelled = false;

    void api<{ homeDir: string }>("/api/v1/system/defaults")
      .then((payload) => {
        if (cancelled) return;
        setCreateCwd(payload.homeDir);
        setCreateCwdInitialized(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCreateCwdInitialized(true);
      });

    return () => {
      cancelled = true;
    };
  }, [createCwdInitialized]);

  useEffect(() => {
    if (enabledAgentTypes.includes(createType)) return;
    setCreateType(enabledAgentTypes[0] ?? "codex");
  }, [createType, enabledAgentTypes]);

  useEffect(() => {
    if (step === "context") {
      requestAnimationFrame(() => promptTextareaRef.current?.focus());
    }
  }, [step]);

  useEffect(() => {
    if (step !== "context") {
      clipboardRequestIdRef.current += 1;
      setCheckingClipboard(false);
      setClipboardReadFeedback(null);
      setDraggingFiles(false);
    }
  }, [step]);

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const typeCmdRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTypeDropdown = useCallback(() => setTypeDropdownOpen(false), []);
  useClickOutside(typeCmdRef, typeDropdownOpen, closeTypeDropdown);

  const handleRemoveCwdHistory = useCallback((cwd: string) => {
    setCwdHistory(removeCwdFromHistory(cwd));
  }, []);

  const handlePathInfoChange = useCallback(
    (info: { isGitRepo: boolean } | null) => {
      cwdPathInfoRef.current = info;
      setCwdIsGitRepo(info ? info.isGitRepo : null);
    },
    []
  );

  // Object URLs for image previews are tracked in a ref so they're created
  // and revoked synchronously alongside the file list, not derived from an
  // effect — that avoids both a one-frame paperclip→thumbnail flicker on add
  // and unnecessary URL churn for unchanged chips on every mutation.
  const startupFilePreviewsRef = useRef<Map<string, string>>(new Map());

  const appendStartupFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setStartupFiles((current) => {
      const next = [...current];
      const seen = new Set(current.map(startupFileKey));
      for (const file of files) {
        const key = startupFileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(file);
        if (
          file.type.startsWith("image/") &&
          !startupFilePreviewsRef.current.has(key)
        ) {
          startupFilePreviewsRef.current.set(key, URL.createObjectURL(file));
        }
      }
      return next;
    });
  }, []);

  const applyClipboardSuggestion = useCallback(
    (suggestion: ClipboardSuggestion) => {
      switch (suggestion.kind) {
        case "image":
        case "file":
          appendStartupFiles([suggestion.file]);
          break;
        case "url":
          setStartupLinks((current) =>
            current.includes(suggestion.url)
              ? current
              : [...current, suggestion.url]
          );
          break;
        case "text": {
          const suggestionText = suggestion.text;
          // Append when the user has typed real content; treat whitespace-only
          // as empty so we don't leave leading blank lines for someone who
          // just clicked into the textarea before reading the clipboard.
          setInitialPrompt((current) =>
            current.trim().length === 0
              ? suggestionText
              : `${current.trimEnd()}\n\n${suggestionText}`
          );
          requestAnimationFrame(() => promptTextareaRef.current?.focus());
          break;
        }
      }
    },
    [appendStartupFiles]
  );

  const handleStartupPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const target = event.target;
      const targetIsPrompt =
        target instanceof HTMLElement && target.id === CONTEXT_PROMPT_ID;
      if (!targetIsPrompt) return;

      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        appendStartupFiles(pastedFiles);
        setClipboardReadFeedback(null);
        return;
      }

      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );

      // Plain text falls through to native paste so the prompt textarea
      // gets the typed content. Only intercept URLs — the user almost
      // always means "add this as a context link," not "paste this URL
      // into the prompt as text."
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        applyClipboardSuggestion(textSuggestion);
        setClipboardReadFeedback(null);
      }
    },
    [appendStartupFiles, applyClipboardSuggestion]
  );

  const handleStartupDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const droppedFiles = Array.from(event.dataTransfer.files ?? []);
      if (droppedFiles.length === 0) return;
      event.preventDefault();
      setDraggingFiles(false);
      appendStartupFiles(droppedFiles);
    },
    [appendStartupFiles]
  );

  const handleStartupFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(event.target.files ?? []);
      appendStartupFiles(selected);
      event.target.value = "";
    },
    [appendStartupFiles]
  );

  const handleRemoveStartupFile = useCallback((fileToRemove: File) => {
    const key = startupFileKey(fileToRemove);
    const url = startupFilePreviewsRef.current.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      startupFilePreviewsRef.current.delete(key);
    }
    setStartupFiles((current) =>
      current.filter((file) => startupFileKey(file) !== key)
    );
  }, []);

  useEffect(() => {
    const previews = startupFilePreviewsRef.current;
    return () => {
      for (const url of previews.values()) {
        URL.revokeObjectURL(url);
      }
      previews.clear();
    };
  }, []);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const enterContextStep = useCallback(() => {
    setStep("context");
    setCheckingClipboard(false);
    setClipboardReadFeedback(null);
  }, []);

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    setClipboardReadFeedback(null);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      if (result.suggestion) {
        applyClipboardSuggestion(result.suggestion);
        return;
      }
      setClipboardReadFeedback(
        result.status === "blocked"
          ? "Clipboard access was blocked. Paste into Instructions instead."
          : result.status === "unsupported"
            ? "Clipboard access isn't available here. Paste into Instructions instead."
            : "Nothing readable found. Try pasting into Instructions instead."
      );
    });
  }, [applyClipboardSuggestion]);

  const normalizedLinkDraft = normalizeUrl(linkDraft);
  const linkDraftIsValid =
    linkDraft.trim().length === 0 || normalizedLinkDraft !== null;

  const addStartupLink = useCallback(() => {
    if (!normalizedLinkDraft) return false;
    setStartupLinks((current) =>
      current.includes(normalizedLinkDraft)
        ? current
        : [...current, normalizedLinkDraft]
    );
    setLinkDraft("");
    return true;
  }, [normalizedLinkDraft]);

  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"menu" | "link">("menu");

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
    // Defer the file picker click so the popover unmounts cleanly first.
    requestAnimationFrame(() => startupFileInputRef.current?.click());
  }, []);

  const handleAddLinkFromMenu = useCallback(() => {
    setAddMode("link");
  }, []);

  const handleAddLinkBack = useCallback(() => {
    setLinkDraft("");
    setAddMode("menu");
  }, []);

  const handleAddLinkSubmit = useCallback(() => {
    if (!addStartupLink()) return;
    setAddMode("menu");
    setAddOpen(false);
  }, [addStartupLink]);

  useRadixPopoverZFix();

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cwd = createCwd.trim();
      if (!cwd) return;
      if (step === "context" && !linkDraftIsValid) return;

      setCreating(true);
      try {
        // The managed-worktree section is hidden for non-git cwds; force the
        // payload to skip worktree creation in that case so the server doesn't
        // try to run git in a non-repo directory.
        const latestPathInfo = cwdPathInfoRef.current;
        const submitUseWorktree =
          latestPathInfo?.isGitRepo === false ? false : createUseWorktree;
        const contextInitialPrompt =
          step === "context" ? initialPrompt.trim() || undefined : undefined;
        const payloadBase = {
          name: createName.trim(),
          cwd,
          type: createType,
          fullAccess: createFullAccess,
          autoReview: createAutoReview,
          useWorktree: submitUseWorktree,
          createNewBranch: submitUseWorktree ? createNewBranch : undefined,
          worktreeBranch:
            submitUseWorktree && createNewBranch
              ? createWorktreeBranch.trim() || undefined
              : undefined,
          baseBranch:
            submitUseWorktree && createBaseBranch !== "main"
              ? createBaseBranch
              : undefined,
          initialPrompt: contextInitialPrompt,
        };
        const resolvedStartupLinks = startupLinks;
        const useStartupContext =
          step === "context" &&
          (startupFiles.length > 0 || resolvedStartupLinks.length > 0);
        const payload = useStartupContext
          ? await (async () => {
              const formData = new FormData();
              for (const [key, value] of Object.entries(payloadBase)) {
                if (value === undefined || value === "") continue;
                formData.append(key, String(value));
              }
              formData.append(
                "startupLinks",
                JSON.stringify(resolvedStartupLinks)
              );
              for (const file of startupFiles) {
                formData.append("startupFiles", file);
              }
              return api<{ agent: Agent }>("/api/v1/agents", {
                method: "POST",
                body: formData,
              });
            })()
          : await api<{ agent: Agent }>("/api/v1/agents", {
              method: "POST",
              body: JSON.stringify(payloadBase),
            });

        if (typeof window !== "undefined") {
          window.localStorage.setItem(LAST_USED_CWD_KEY, cwd);
          window.localStorage.setItem(LAST_USED_TYPE_KEY, createType);
        }
        setCwdHistory(addToCwdHistory(cwd));
        await onCreated(payload.agent, createType);
      } finally {
        setCreating(false);
      }
    },
    [
      createAutoReview,
      createBaseBranch,
      createCwd,
      createFullAccess,
      createName,
      createNewBranch,
      createType,
      createUseWorktree,
      createWorktreeBranch,
      initialPrompt,
      linkDraftIsValid,
      onCreated,
      startupFiles,
      startupLinks,
      step,
    ]
  );

  const worktreeAvailable = cwdIsGitRepo !== false;
  const worktreeChecked = worktreeAvailable && createUseWorktree;

  return (
    <DialogContent
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
        if (e.defaultPrevented) return;
        if (typeDropdownOpen) {
          e.preventDefault();
        }
        if (step === "context") {
          e.preventDefault();
          setStep("config");
        }
      }}
    >
      {step === "config" ? (
        <>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              Name, type, and working directory for a new agent session.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-form"
            className="flex min-h-0 flex-col"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-3">
                <div className="relative space-y-1" ref={typeCmdRef}>
                  <label className="text-sm text-muted-foreground">Type</label>
                  <button
                    ref={typeTriggerRef}
                    type="button"
                    role="combobox"
                    tabIndex={0}
                    aria-expanded={typeDropdownOpen}
                    onClick={() => setTypeDropdownOpen((prev) => !prev)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "ArrowDown" ||
                        e.key === "Enter" ||
                        e.key === " "
                      ) {
                        e.preventDefault();
                        if (!typeDropdownOpen) setTypeDropdownOpen(true);
                      }
                    }}
                    className={cn(
                      "flex h-9 w-full items-center justify-between rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring"
                    )}
                  >
                    {AGENT_TYPE_LABELS[createType]}
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform",
                        typeDropdownOpen && "rotate-180"
                      )}
                    />
                  </button>
                  {typeDropdownOpen ? (
                    <div className="absolute left-0 right-0 z-[80] mt-1 rounded-md border border-white/[0.2] bg-[hsl(var(--card))] shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl">
                      <Command
                        shouldFilter={false}
                        ref={(el) => {
                          if (el) requestAnimationFrame(() => el.focus());
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setTypeDropdownOpen(false);
                            requestAnimationFrame(() =>
                              typeTriggerRef.current?.focus()
                            );
                          }
                        }}
                      >
                        <CommandList>
                          <CommandGroup>
                            {enabledAgentTypes.map((agentType) => (
                              <CommandItem
                                key={agentType}
                                value={agentType}
                                onSelect={() => {
                                  setCreateType(agentType);
                                  setTypeDropdownOpen(false);
                                  requestAnimationFrame(() =>
                                    typeTriggerRef.current?.focus()
                                  );
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-3 w-3 shrink-0",
                                    agentType === createType
                                      ? "opacity-100"
                                      : "opacity-0"
                                  )}
                                />
                                {AGENT_TYPE_LABELS[agentType]}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label className="text-sm text-muted-foreground">Name</label>
                  <Input
                    autoFocus
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    placeholder="agent name"
                    data-testid="create-agent-name"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank and the agent will set its own name based on the
                    task.
                  </p>
                </div>

                <PathInput
                  value={createCwd}
                  onChange={setCreateCwd}
                  label="Working directory"
                  history={cwdHistory}
                  onRemoveHistory={handleRemoveCwdHistory}
                  onPathInfoChange={handlePathInfoChange}
                  data-testid="create-agent-cwd"
                  historyItemTestId="create-agent-cwd-history-option"
                />

                <div
                  className={cn(
                    "space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 transition-opacity duration-200",
                    !worktreeAvailable && "opacity-60"
                  )}
                  data-testid="create-agent-worktree-section"
                >
                  <label
                    className={cn(
                      "flex items-start gap-3",
                      worktreeAvailable
                        ? "cursor-pointer"
                        : "cursor-not-allowed"
                    )}
                  >
                    <Checkbox
                      checked={worktreeChecked}
                      onCheckedChange={() =>
                        setCreateUseWorktree((current) => !current)
                      }
                      disabled={!worktreeAvailable}
                      className="mt-0.5"
                      title={
                        worktreeAvailable
                          ? "Toggle managed git worktree"
                          : "Not a git repository"
                      }
                      data-testid="create-agent-worktree"
                    />
                    <span className="space-y-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                        <GitBranch className="h-3.5 w-3.5" />
                        Create managed git worktree
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {worktreeAvailable
                          ? "Creates an isolated worktree for this agent. Dispatch tracks and cleans it up when the agent is archived."
                          : "Working directory isn't a git repository, so a managed worktree isn't available here."}
                      </span>
                    </span>
                  </label>
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                      worktreeChecked
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    )}
                    aria-hidden={!worktreeChecked}
                    // Keep collapsed controls out of focus and pointer
                    // interaction. Cast for React 18 type defs.
                    {...(!worktreeChecked
                      ? ({ inert: "" } as Record<string, string>)
                      : {})}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="ml-8 w-[calc(100%-2rem)] space-y-3 pt-1">
                        <BranchSelect
                          cwd={createCwd}
                          baseBranch={createBaseBranch}
                          onBaseBranchChange={setCreateBaseBranch}
                          worktreeBranch={createWorktreeBranch}
                          onWorktreeBranchChange={setCreateWorktreeBranch}
                          baseBranchLabel="Starting branch"
                          baseBranchHelper="The branch to check out in the worktree."
                          showNewBranchInput={false}
                          testIdPrefix="create-agent"
                        />
                        <div className="space-y-2 rounded-md border border-border/60 bg-background/40 px-3 py-3">
                          <label className="flex cursor-pointer items-start gap-3">
                            <Checkbox
                              checked={createNewBranch}
                              onCheckedChange={() =>
                                setCreateNewBranch((current) => !current)
                              }
                              className="mt-0.5"
                              title="Toggle new branch creation"
                              data-testid="create-agent-new-branch"
                            />
                            <span className="space-y-1">
                              <span className="block text-sm font-medium text-foreground">
                                Create a new branch in this worktree
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                Creates a new working branch from the starting
                                branch so the agent can make isolated changes
                                for later submission.
                              </span>
                            </span>
                          </label>
                          <div
                            className={cn(
                              "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                              createNewBranch
                                ? "grid-rows-[1fr] opacity-100"
                                : "grid-rows-[0fr] opacity-0"
                            )}
                            aria-hidden={!createNewBranch}
                            {...(!createNewBranch
                              ? ({ inert: "" } as Record<string, string>)
                              : {})}
                          >
                            <div className="min-h-0 overflow-hidden">
                              <div className="space-y-1 pt-2">
                                <label className="block text-xs text-muted-foreground">
                                  New branch name
                                </label>
                                <Input
                                  value={createWorktreeBranch}
                                  onChange={(event) =>
                                    setCreateWorktreeBranch(event.target.value)
                                  }
                                  placeholder="auto-generated if empty"
                                  data-testid="create-agent-worktree-branch"
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {createType !== "terminal" ? (
                  <>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={createFullAccess}
                        onCheckedChange={() =>
                          setCreateFullAccess((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle full access"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Start in full access mode
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Starts the selected agent with its most permissive
                          supported execution mode.
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                      <Checkbox
                        checked={createAutoReview}
                        onCheckedChange={() =>
                          setCreateAutoReview((current) => !current)
                        }
                        className="mt-0.5"
                        title="Toggle autonomous review"
                        data-testid="create-agent-auto-review"
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium text-foreground">
                          Autonomous Review
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          Agent will launch one review agent and address
                          feedback before completing.
                        </span>
                      </span>
                    </label>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                onClick={() => setOpen(false)}
                data-testid="create-agent-cancel"
              >
                Cancel
              </Button>
              {createType !== "terminal" ? (
                <Button
                  type="button"
                  variant="default"
                  tabIndex={0}
                  disabled={creating || !createCwd.trim()}
                  data-testid="create-agent-with-context"
                  onClick={enterContextStep}
                >
                  Create with context
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                disabled={creating}
                data-testid="create-agent-submit"
              >
                {creating ? (
                  <ActivityBars size={16} className="mr-1.5" />
                ) : null}
                Create
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Create with context</DialogTitle>
            <DialogDescription>
              Add startup instructions, files, and links for the agent to use
              when the session starts.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-context-form"
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => void handleSubmit(event)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                setDraggingFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return;
              }
              setDraggingFiles(false);
            }}
            onDrop={handleStartupDrop}
          >
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-lg px-1 pb-1"
              )}
            >
              <div className="space-y-3">
                <div
                  className="rounded-lg border border-dashed border-white/[0.12] bg-white/[0.03] px-3 py-3"
                  data-testid="create-agent-context-clipboard-check"
                >
                  <Button
                    type="button"
                    variant="default"
                    className="min-h-11 w-full justify-center px-3"
                    onClick={handleCheckClipboard}
                    disabled={checkingClipboard}
                    data-testid="create-agent-context-clipboard-check-action"
                  >
                    {checkingClipboard ? (
                      <ActivityBars size={16} className="mr-1.5" />
                    ) : (
                      <Clipboard className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Read clipboard
                  </Button>
                  {clipboardReadFeedback ? (
                    <p
                      className="mt-2 text-xs text-muted-foreground"
                      role="status"
                      aria-live="polite"
                      data-testid="create-agent-context-clipboard-feedback"
                    >
                      {clipboardReadFeedback}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <label
                    htmlFor={CONTEXT_PROMPT_ID}
                    className="text-sm text-muted-foreground"
                  >
                    Instructions
                  </label>
                  <textarea
                    id={CONTEXT_PROMPT_ID}
                    ref={promptTextareaRef}
                    value={initialPrompt}
                    onChange={(event) => setInitialPrompt(event.target.value)}
                    onPaste={handleStartupPaste}
                    placeholder="Enter instructions for the agent..."
                    data-testid="create-agent-initial-prompt"
                    className={cn(
                      "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  />
                </div>

                <div
                  className={cn(
                    "space-y-3 rounded-md border bg-muted/20 px-3 py-3 transition-colors",
                    draggingFiles
                      ? "border-status-done/35 bg-status-done/8 ring-1 ring-inset ring-status-done/30"
                      : "border-border/70"
                  )}
                >
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Context
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Attach files or links to give the agent context.
                    </p>
                  </div>
                  <input
                    ref={startupFileInputRef}
                    type="file"
                    multiple
                    accept={STARTUP_FILE_ACCEPT}
                    className="hidden"
                    onChange={handleStartupFileChange}
                    data-testid="create-agent-context-files-input"
                  />
                  {startupFiles.length === 0 && startupLinks.length === 0 ? (
                    <Popover open={addOpen} onOpenChange={handleAddOpenChange}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-testid="create-agent-context-files-button"
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
                                Click to choose, or drop a file here
                              </span>
                            </>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-72 p-1"
                        forceMount
                      >
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
                          />
                        )}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <div className="flex flex-wrap items-start gap-3">
                      {startupFiles.map((file) => {
                        const key = startupFileKey(file);
                        const preview = startupFilePreviewsRef.current.get(key);
                        return (
                          <div
                            key={key}
                            className="group flex w-12 flex-col gap-0.5"
                          >
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
                                onClick={() => handleRemoveStartupFile(file)}
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
                      {startupLinks.map((link) => {
                        const { host, rest } = startupLinkLabel(link);
                        return (
                          <div
                            key={link}
                            className="group relative flex h-12 max-w-[180px] flex-col justify-center gap-0.5 rounded-md border border-border/70 bg-muted/40 px-2 pr-7 leading-tight"
                            title={link}
                          >
                            <div className="flex items-center gap-1 text-[10px] text-foreground">
                              <Link2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
                              <span className="truncate font-medium">
                                {host}
                              </span>
                            </div>
                            {rest ? (
                              <span className="truncate text-[9px] text-muted-foreground">
                                {rest}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="absolute -right-2 -top-2 flex h-10 w-10 items-start justify-end rounded-full p-2 text-muted-foreground transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                              onClick={() => handleRemoveStartupLink(link)}
                              aria-label={`Remove ${link}`}
                            >
                              <span className="rounded-full border border-border/70 bg-background p-0.5">
                                <X className="h-2.5 w-2.5" />
                              </span>
                            </button>
                          </div>
                        );
                      })}
                      <Popover
                        open={addOpen}
                        onOpenChange={handleAddOpenChange}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid="create-agent-context-files-button"
                            aria-label="Add context"
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
                        <PopoverContent
                          align="start"
                          className="w-72 p-1"
                          forceMount
                        >
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
                            />
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-between gap-2 border-t border-white/[0.08] pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                className="min-h-11 px-3"
                onClick={() => setStep("config")}
                data-testid="create-agent-context-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  disabled={creating || !linkDraftIsValid}
                  data-testid="create-agent-context-submit"
                >
                  {creating ? (
                    <ActivityBars size={16} className="mr-1.5" />
                  ) : null}
                  Create
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </DialogContent>
  );
}
