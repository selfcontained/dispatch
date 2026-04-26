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
  GitBranch,
  Clipboard,
  ChevronLeft,
  Link2,
  Paperclip,
  Plus,
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
import { type Agent } from "@/components/app/types";
import { useClickOutside } from "@/hooks/use-click-outside";
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
const STARTUP_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.mp4,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.sh,.sql,.diff,.patch,.env,.ini,.cfg,.conf,.swift,.kt,.java,.c,.cpp,.h,.hpp,.rb,.php,.lua,.zig,.nim,.r,.m,.ex,.exs,.erl,.hs";
const URL_PROTOCOLS = new Set(["http:", "https:"]);
const CONTEXT_PROMPT_ID = "create-agent-context-prompt";
const CONTEXT_LINK_INPUT_ID = "create-agent-context-link-input";
const CONTEXT_LINK_ERROR_ID = "create-agent-context-link-error";
const ROUND_ICON_BUTTON_CLASS =
  "h-10 w-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground";

type ClipboardSuggestion =
  | {
      kind: "image" | "file";
      title: string;
      description: string;
      actionLabel: string;
      file: File;
    }
  | {
      kind: "url";
      title: string;
      description: string;
      actionLabel: string;
      url: string;
    }
  | {
      kind: "text";
      title: string;
      description: string;
      actionLabel: string;
      text: string;
    };

type ClipboardLookupResult =
  | {
      suggestion: ClipboardSuggestion;
      canRead: boolean;
    }
  | {
      suggestion: null;
      canRead: boolean;
    };

function isLikelyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function describeClipboardFileType(type: string): {
  noun: string;
  actionLabel: string;
} {
  if (type.startsWith("image/")) {
    return {
      noun: "image",
      actionLabel: "Add clipboard image",
    };
  }
  if (type === "application/pdf") {
    return {
      noun: "PDF",
      actionLabel: "Add clipboard PDF",
    };
  }
  if (type.startsWith("video/")) {
    return {
      noun: "video",
      actionLabel: "Add clipboard video",
    };
  }
  if (type.startsWith("audio/")) {
    return {
      noun: "audio file",
      actionLabel: "Add clipboard audio",
    };
  }
  if (type.startsWith("text/")) {
    return {
      noun: "text file",
      actionLabel: "Add clipboard file",
    };
  }
  return {
    noun: "file",
    actionLabel: "Add clipboard file",
  };
}

function isClipboardAttachmentType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf"
  );
}

function extensionForMimeType(type: string): string {
  switch (type) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default: {
      const subtype = type.split("/")[1]?.split(";")[0]?.trim();
      return subtype || "bin";
    }
  }
}

function createClipboardFile(blob: Blob): File {
  const type = blob.type || "application/octet-stream";
  const { noun } = describeClipboardFileType(type);
  const baseName = noun === "image" ? "clipboard-image" : "clipboard-file";
  return new File([blob], `${baseName}.${extensionForMimeType(type)}`, {
    type,
    lastModified: Date.now(),
  });
}

function createClipboardSuggestionFromFile(file: File): ClipboardSuggestion {
  const typeInfo = describeClipboardFileType(file.type);
  return {
    kind: file.type.startsWith("image/") ? "image" : "file",
    title: file.type.startsWith("image/")
      ? "Clipboard image ready"
      : "Clipboard file ready",
    description: `Add copied ${typeInfo.noun}?`,
    actionLabel: typeInfo.actionLabel,
    file,
  };
}

function createClipboardSuggestionFromText(
  text: string
): ClipboardSuggestion | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isLikelyUrl(trimmed)) {
    return {
      kind: "url",
      title: "Copied link ready",
      description: "Add copied link?",
      actionLabel: "Add copied link",
      url: trimmed,
    };
  }
  return {
    kind: "text",
    title: "Copied prompt ready",
    description: "Use copied text as instructions?",
    actionLabel: "Use copied text",
    text: trimmed,
  };
}

function getClipboardFilesFromEvent(
  event: ClipboardEvent<HTMLElement>
): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

async function getClipboardSuggestion(): Promise<ClipboardLookupResult> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return {
      suggestion: null,
      canRead: false,
    };
  }

  const canRead =
    typeof navigator.clipboard.read === "function" ||
    typeof navigator.clipboard.readText === "function";

  if (typeof navigator.clipboard.read === "function") {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const fileType = item.types.find(isClipboardAttachmentType);
        if (!fileType) continue;
        const blob = await item.getType(fileType);
        return {
          suggestion: createClipboardSuggestionFromFile(
            createClipboardFile(blob)
          ),
          canRead,
        };
      }
    } catch {
      // Fall through to readText.
    }
  }

  if (typeof navigator.clipboard.readText === "function") {
    try {
      const suggestion = createClipboardSuggestionFromText(
        await navigator.clipboard.readText()
      );
      return suggestion
        ? {
            suggestion,
            canRead,
          }
        : {
            suggestion: null,
            canRead,
          };
    } catch {
      return {
        suggestion: null,
        canRead,
      };
    }
  }

  return {
    suggestion: null,
    canRead,
  };
}

function getClipboardSuggestionClasses(suggestion: ClipboardSuggestion): {
  container: string;
  title: string;
} {
  switch (suggestion.kind) {
    case "url":
      return {
        container:
          "border-status-done/35 bg-status-done/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_hsl(var(--status-done)/0.08)]",
        title: "text-status-done",
      };
    case "text":
      return {
        container:
          "border-status-working/35 bg-status-working/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_hsl(var(--status-working)/0.08)]",
        title: "text-status-working",
      };
    default:
      return {
        container:
          "border-status-waiting/35 bg-status-waiting/12 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_hsl(var(--status-waiting)/0.08)]",
        title: "text-status-waiting",
      };
  }
}

function startupFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
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
  const [initialPrompt, setInitialPrompt] = useState("");
  const [startupFiles, setStartupFiles] = useState<File[]>([]);
  const [startupLinks, setStartupLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [clipboardSuggestion, setClipboardSuggestion] =
    useState<ClipboardSuggestion | null>(null);
  const [checkingClipboard, setCheckingClipboard] = useState(false);
  const [canReadClipboard, setCanReadClipboard] = useState(false);
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
      setClipboardSuggestion(null);
      setCheckingClipboard(false);
      setCanReadClipboard(false);
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
      setCwdIsGitRepo(info ? info.isGitRepo : null);
    },
    []
  );

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
      }
      return next;
    });
  }, []);

  const handleStartupPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const pastedFiles = getClipboardFilesFromEvent(event);
      if (pastedFiles.length > 0) {
        event.preventDefault();
        setClipboardSuggestion(
          createClipboardSuggestionFromFile(pastedFiles[0])
        );
        return;
      }

      const target = event.target;
      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      const targetIsPrompt =
        target instanceof HTMLElement && target.id === CONTEXT_PROMPT_ID;

      if (textSuggestion?.kind === "url" && targetIsPrompt) {
        event.preventDefault();
        setClipboardSuggestion(textSuggestion);
      }
    },
    []
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
    setStartupFiles((current) =>
      current.filter(
        (file) => startupFileKey(file) !== startupFileKey(fileToRemove)
      )
    );
  }, []);

  const addStartupLink = useCallback(() => {
    const trimmed = linkDraft.trim();
    if (!trimmed || !isLikelyUrl(trimmed)) return;
    setStartupLinks((current) =>
      current.includes(trimmed) ? current : [...current, trimmed]
    );
    setLinkDraft("");
  }, [linkDraft]);

  const handleRemoveStartupLink = useCallback((linkToRemove: string) => {
    setStartupLinks((current) =>
      current.filter((link) => link !== linkToRemove)
    );
  }, []);

  const enterContextStep = useCallback(() => {
    setStep("context");
    setClipboardSuggestion(null);
    setCheckingClipboard(true);
    setCanReadClipboard(false);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      setCanReadClipboard(result.canRead);
      if (result.suggestion) {
        setClipboardSuggestion(result.suggestion);
      }
    });
  }, []);

  const handleCheckClipboard = useCallback(() => {
    setCheckingClipboard(true);
    const requestId = clipboardRequestIdRef.current + 1;
    clipboardRequestIdRef.current = requestId;
    void getClipboardSuggestion().then((result) => {
      if (clipboardRequestIdRef.current !== requestId) return;
      setCheckingClipboard(false);
      setCanReadClipboard(result.canRead);
      if (result.suggestion) {
        setClipboardSuggestion(result.suggestion);
      }
    });
  }, []);

  const trimmedLinkDraft = linkDraft.trim();
  const linkDraftIsValid =
    trimmedLinkDraft.length === 0 || isLikelyUrl(trimmedLinkDraft);

  const handleUseClipboardSuggestion = useCallback(() => {
    if (!clipboardSuggestion) return;

    switch (clipboardSuggestion.kind) {
      case "image":
      case "file":
        appendStartupFiles([clipboardSuggestion.file]);
        break;
      case "url":
        setStartupLinks((current) =>
          current.includes(clipboardSuggestion.url)
            ? current
            : [...current, clipboardSuggestion.url]
        );
        break;
      case "text": {
        const suggestionText = clipboardSuggestion.text;
        setInitialPrompt((current) => {
          if (!current.trim()) return suggestionText;
          return `${current.trimEnd()}\n\n${suggestionText}`;
        });
        requestAnimationFrame(() => promptTextareaRef.current?.focus());
        break;
      }
    }

    setClipboardSuggestion(null);
  }, [appendStartupFiles, clipboardSuggestion]);

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
        const submitUseWorktree =
          cwdIsGitRepo === false ? false : createUseWorktree;
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
          initialPrompt: initialPrompt.trim() || undefined,
        };
        const resolvedStartupLinks =
          step === "context" && trimmedLinkDraft
            ? Array.from(new Set([...startupLinks, trimmedLinkDraft]))
            : startupLinks;
        const useStartupContext =
          step === "context" &&
          (payloadBase.initialPrompt ||
            startupFiles.length > 0 ||
            resolvedStartupLinks.length > 0);
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
      cwdIsGitRepo,
      initialPrompt,
      linkDraftIsValid,
      onCreated,
      startupFiles,
      startupLinks,
      step,
      trimmedLinkDraft,
    ]
  );

  const worktreeAvailable = cwdIsGitRepo !== false;
  const worktreeChecked = worktreeAvailable && createUseWorktree;
  const clipboardSuggestionClasses = clipboardSuggestion
    ? getClipboardSuggestionClasses(clipboardSuggestion)
    : null;

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
            onPaste={handleStartupPaste}
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
                "min-h-0 flex-1 overflow-y-auto rounded-lg px-1 pb-1 transition-colors",
                draggingFiles &&
                  "bg-status-done/8 ring-1 ring-inset ring-status-done/30"
              )}
            >
              <div className="space-y-3">
                {clipboardSuggestion ? (
                  <div
                    className={cn(
                      "space-y-3 rounded-lg border px-3 py-3",
                      clipboardSuggestionClasses?.container
                    )}
                    data-testid="create-agent-context-clipboard-cta"
                  >
                    <div className="flex items-start gap-3">
                      <p
                        className={cn(
                          "min-w-0 flex-1 text-sm leading-relaxed",
                          clipboardSuggestionClasses?.title
                        )}
                      >
                        {clipboardSuggestion.description}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn("mt-[-2px]", ROUND_ICON_BUTTON_CLASS)}
                        onClick={() => setClipboardSuggestion(null)}
                        data-testid="create-agent-context-clipboard-dismiss"
                        aria-label="Dismiss clipboard suggestion"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="default"
                      className="min-h-11 w-full justify-center px-3"
                      onClick={handleUseClipboardSuggestion}
                      data-testid="create-agent-context-clipboard-action"
                    >
                      {clipboardSuggestion.kind === "url" ? (
                        <Link2 className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {clipboardSuggestion.actionLabel}
                    </Button>
                  </div>
                ) : null}
                {!clipboardSuggestion && canReadClipboard ? (
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
                  </div>
                ) : null}

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
                    placeholder="Enter instructions for the agent..."
                    data-testid="create-agent-initial-prompt"
                    className={cn(
                      "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  />
                </div>

                <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        Files
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Attach files or paste images/documents from the
                        clipboard.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="default"
                      className="min-h-11 px-3"
                      onClick={() => startupFileInputRef.current?.click()}
                      data-testid="create-agent-context-files-button"
                    >
                      <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                      Add files
                    </Button>
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
                  {startupFiles.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {startupFiles.map((file) => (
                        <div
                          key={startupFileKey(file)}
                          className="flex items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 py-1 text-xs text-foreground"
                        >
                          <Paperclip className="h-3 w-3 text-muted-foreground" />
                          <span className="max-w-[260px] truncate">
                            {file.name}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={ROUND_ICON_BUTTON_CLASS}
                            onClick={() => handleRemoveStartupFile(file)}
                            aria-label={`Remove ${file.name}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No files added yet.
                    </p>
                  )}
                </div>

                <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      Links
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Add one or more URLs to pin into the new session.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label
                      htmlFor={CONTEXT_LINK_INPUT_ID}
                      className="text-sm text-muted-foreground"
                    >
                      Link URL
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={CONTEXT_LINK_INPUT_ID}
                        value={linkDraft}
                        onChange={(event) => setLinkDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addStartupLink();
                          }
                        }}
                        placeholder="https://..."
                        data-testid="create-agent-context-link-input"
                        aria-invalid={!linkDraftIsValid}
                        aria-describedby={
                          !linkDraftIsValid ? CONTEXT_LINK_ERROR_ID : undefined
                        }
                      />
                      <Button
                        type="button"
                        variant="default"
                        className="min-h-11 px-3"
                        onClick={addStartupLink}
                        data-testid="create-agent-context-link-add"
                        disabled={!trimmedLinkDraft || !linkDraftIsValid}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add
                      </Button>
                    </div>
                  </div>
                  {!linkDraftIsValid ? (
                    <p
                      id={CONTEXT_LINK_ERROR_ID}
                      className="text-xs text-status-blocked"
                      data-testid="create-agent-context-link-error"
                    >
                      Enter a valid `http:` or `https:` URL.
                    </p>
                  ) : null}
                  {startupLinks.length > 0 ? (
                    <div className="space-y-2">
                      {startupLinks.map((link) => (
                        <div
                          key={link}
                          className="flex items-center gap-2 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-xs text-foreground"
                        >
                          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">
                            {link}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={ROUND_ICON_BUTTON_CLASS}
                            onClick={() => handleRemoveStartupLink(link)}
                            aria-label={`Remove ${link}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No links added yet.
                    </p>
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
