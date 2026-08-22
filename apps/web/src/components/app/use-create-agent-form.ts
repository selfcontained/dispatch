import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import {
  createClipboardSuggestionFromText,
  getClipboardFilesFromEvent,
} from "@/components/app/create-agent-dialog-clipboard";
import {
  CONTEXT_PROMPT_ID,
  LAST_USED_CWD_KEY,
  LAST_USED_TYPE_KEY,
  readLastUsedAgentType,
  readLastUsedCwd,
  useCwdHistory,
  useCreateAgentPrefs,
} from "@/components/app/create-agent-dialog-utils";
import { type Agent } from "@/components/app/types";
import { useStartupAttachments } from "@/components/app/use-startup-attachments";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useSystemDefaults } from "@/hooks/use-system-defaults";
import { type AgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";

type UseCreateAgentFormOptions = {
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
};

type CwdPathInfo = {
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
};

export function useCreateAgentForm({
  enabledAgentTypes,
  initialAgentType,
  resolveDefaultCwd,
  onCreated,
}: UseCreateAgentFormOptions) {
  const [step, setStep] = useState<"config" | "context">("config");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
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
  const [cwdPathInfo, setCwdPathInfo] = useState<CwdPathInfo | null>(null);
  const cwdPathInfoRef = useRef<CwdPathInfo | null>(null);
  // Flips true the first time the cwd is confirmed a git repo, and never
  // resets — see the reset effect below for why.
  const hasHadAvailableWorktreeRef = useRef(false);
  const [initialPrompt, setInitialPrompt] = useState("");
  const {
    startupFiles,
    startupLinks,
    draggingFiles,
    setDraggingFiles,
    startupFilePreviewsRef,
    appendStartupFiles,
    handleAddLink,
    handleRemoveStartupFile,
    handleRemoveStartupLink,
    handleStartupDrop,
  } = useStartupAttachments();
  const [contextDraftInvalid, setContextDraftInvalid] = useState(false);
  const [creating, setCreating] = useState(false);
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    add: addCwdHistory,
    remove: removeCwdHistory,
  } = useCwdHistory();
  const {
    fullAccess: createFullAccess,
    setFullAccess: setCreateFullAccess,
    autoReview: createAutoReview,
    setAutoReview: setCreateAutoReview,
    baseBranch: createBaseBranch,
    setBaseBranch: setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
    model: createModel,
    setModel: setCreateModel,
  } = useCreateAgentPrefs(createCwd, createType);
  const {
    options: modelOptions,
    loading: modelCatalogLoading,
    loaded: modelCatalogLoaded,
  } = useAgentModelCatalog(createType);

  const handleCreateUseWorktreeChange = useCallback(
    (useWorktree: boolean) => {
      setCreateUseWorktree(useWorktree);
      if (!useWorktree) setCreateNewBranch(false);
    },
    [setCreateNewBranch]
  );

  useEffect(() => {
    if (!modelCatalogLoaded) return;
    // Anything stored that the catalog no longer offers (a retired id, or an
    // empty string persisted by an older build) resets to the CLI default.
    if (
      createModel !== null &&
      !modelOptions.some((option) => option.id === createModel)
    ) {
      setCreateModel(null);
    }
  }, [createModel, modelCatalogLoaded, modelOptions, setCreateModel]);

  useEffect(() => {
    setCreateWorktreeBranch("");
  }, [createCwd]);

  const cwdIsGitRepo = cwdPathInfo ? cwdPathInfo.isGitRepo : null;
  // A settled result for a path that doesn't exist yet (a half-typed path,
  // mid-Tab-completion) also reports isGitRepo: false — that's not the same
  // as the user actually pointing at a real non-repo directory, and acting
  // on it would clobber their checkbox choice on every debounce tick while
  // they're still typing toward a repo. Only a fully resolved, existing,
  // non-repo directory counts.
  const cwdConfirmedNonRepoDirectory =
    cwdPathInfo !== null &&
    cwdPathInfo.exists &&
    cwdPathInfo.isDirectory &&
    !cwdPathInfo.isGitRepo;

  // The submit path already guards against sending useWorktree for a
  // non-repo cwd (see handleSubmit's submitUseWorktree), and the derived
  // worktreeChecked/worktreeAvailable below already keep the checkbox
  // *rendering* unchecked while disabled. But without this, the underlying
  // preference stays true, so flipping back to a repo dir would silently
  // re-check it on its own. Force the actual state off once the cwd is
  // confirmed to be a real, existing non-repo directory — but only after
  // the cwd has been an available repo at least once, so opening the dialog
  // on a non-repo default cwd (home dir, no last-used project) doesn't wipe
  // the untouched useState(true) default before the user has touched
  // anything. createNewBranch doesn't need a matching reset: its own
  // checked state already cascades from worktreeChecked in
  // create-agent-worktree-section.tsx, so forcing this off already hides it.
  useEffect(() => {
    if (cwdIsGitRepo === true) {
      hasHadAvailableWorktreeRef.current = true;
    } else if (
      cwdConfirmedNonRepoDirectory &&
      hasHadAvailableWorktreeRef.current
    ) {
      setCreateUseWorktree(false);
    }
  }, [cwdIsGitRepo, cwdConfirmedNonRepoDirectory]);

  const { data: systemDefaults, isError: systemDefaultsError } =
    useSystemDefaults();
  useEffect(() => {
    if (createCwdInitialized) return;
    if (systemDefaults) {
      setCreateCwd(systemDefaults.homeDir);
      setCreateCwdInitialized(true);
    } else if (systemDefaultsError) {
      setCreateCwdInitialized(true);
    }
  }, [createCwdInitialized, systemDefaults, systemDefaultsError]);

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
      setDraggingFiles(false);
    }
  }, [setDraggingFiles, step]);

  const handlePathInfoChange = useCallback((info: CwdPathInfo | null) => {
    cwdPathInfoRef.current = info;
    setCwdPathInfo(info);
  }, []);

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
        return;
      }

      const textSuggestion = createClipboardSuggestionFromText(
        event.clipboardData.getData("text/plain")
      );
      if (textSuggestion?.kind === "url") {
        event.preventDefault();
        handleAddLink(textSuggestion.url);
      }
    },
    [appendStartupFiles, handleAddLink]
  );

  const handleClipboardText = useCallback((text: string) => {
    setInitialPrompt((current) =>
      current.trim().length === 0 ? text : `${current.trimEnd()}\n\n${text}`
    );
    requestAnimationFrame(() => promptTextareaRef.current?.focus());
  }, []);

  const enterContextStep = useCallback(() => {
    setStep("context");
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cwd = createCwd.trim();
      if (!cwd) return;

      setCreating(true);
      try {
        const latestPathInfo = cwdPathInfoRef.current;
        const submitUseWorktree =
          latestPathInfo?.isGitRepo === false ? false : createUseWorktree;
        const contextInitialPrompt =
          step === "context" ? initialPrompt.trim() || undefined : undefined;
        const payloadBase = {
          name: createName.trim(),
          cwd,
          type: createType,
          model: modelOptions.some((option) => option.id === createModel)
            ? createModel
            : undefined,
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
        addCwdHistory(cwd);
        await onCreated(payload.agent, createType);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create agent.";
        toast.error(message);
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
      createModel,
      createNewBranch,
      createType,
      createUseWorktree,
      createWorktreeBranch,
      initialPrompt,
      addCwdHistory,
      onCreated,
      startupFiles,
      startupLinks,
      step,
      modelOptions,
    ]
  );

  const worktreeAvailable = cwdIsGitRepo === true;
  const worktreeChecked = worktreeAvailable && createUseWorktree;

  return {
    step,
    setStep,
    promptTextareaRef,
    createName,
    setCreateName,
    createType,
    setCreateType,
    createCwd,
    setCreateCwd,
    createUseWorktree,
    setCreateUseWorktree: handleCreateUseWorktreeChange,
    createWorktreeBranch,
    setCreateWorktreeBranch,
    initialPrompt,
    setInitialPrompt,
    startupFiles,
    startupLinks,
    draggingFiles,
    setDraggingFiles,
    contextDraftInvalid,
    setContextDraftInvalid,
    creating,
    createFullAccess,
    setCreateFullAccess,
    createAutoReview,
    setCreateAutoReview,
    createModel,
    setCreateModel,
    modelOptions,
    modelCatalogLoading,
    createBaseBranch,
    setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
    cwdHistory,
    removableCwdHistory,
    cwdHistoryMetadata,
    removeCwdHistory,
    worktreeAvailable,
    worktreeChecked,
    startupFilePreviewsRef,
    handlePathInfoChange,
    appendStartupFiles,
    handleAddLink,
    handleStartupPaste,
    handleStartupDrop,
    handleRemoveStartupFile,
    handleRemoveStartupLink,
    handleClipboardText,
    enterContextStep,
    handleSubmit,
  };
}
