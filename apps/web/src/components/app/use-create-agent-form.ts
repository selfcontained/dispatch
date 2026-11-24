import {
  useLaunchTargets,
  useLaunchTargetData,
} from "@/hooks/use-launch-targets";
import type { Effort } from "@dispatch/shared";
import { useAtom } from "jotai";
import { useProjects } from "@/hooks/use-projects";
import { createAgentLocationPrefAtom } from "@/lib/store";
import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
  sourceAgentId?: string;
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  resolveDefaultCwd: () => string;
  initialProjectId?: string | null;
  /**
   * Creating for a task: the server briefs the agent on it and assigns it,
   * and the agent lives in the task's project whatever was last used.
   */
  task?: { id: string; title: string; projectId: string } | null;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
};

type CwdPathInfo = {
  isGitRepo: boolean;
};

type ValidatedCwd = CwdPathInfo & {
  cwd: string;
};

export function useCreateAgentForm({
  sourceAgentId,
  enabledAgentTypes,
  initialAgentType,
  resolveDefaultCwd,
  initialProjectId,
  task = null,
  onCreated,
}: UseCreateAgentFormOptions) {
  const launch = useLaunchTargets(
    sourceAgentId ? { kind: "agent", id: sourceAgentId } : undefined
  );
  const [locationPref, setLocationPref] = useAtom(createAgentLocationPrefAtom);
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  // The scope seeds this opening, but a picker choice (including Folder)
  // belongs to the mounted form and must survive preference hydration/rerenders.
  const [locationChoice, setLocationChoice] = useState<{
    projectId: string | null;
  } | null>(null);
  const selectedProjectId = task
    ? task.projectId
    : locationChoice
      ? locationChoice.projectId
      : sourceAgentId && launch.target?.location.kind === "project"
        ? (launch.projection.data?.projectId ?? null)
        : (initialProjectId ??
          (locationPref?.mode === "project" ? locationPref.projectId : null));
  const project = (launch.target?.location.projects ?? projects).find(
    (p) => p.id === selectedProjectId
  );
  // Keep a pending choice while loading, but never submit an unavailable ID.
  const createProjectId = projectsLoaded
    ? (project?.id ?? null)
    : selectedProjectId;
  const locationReady =
    (!selectedProjectId || projectsLoaded) &&
    launch.selectionReady &&
    (!sourceAgentId || launch.projection.isSuccess) &&
    (launch.target?.location.kind !== "project" || Boolean(project));
  const setCreateProjectId = (id: string | null) => {
    setLocationChoice({ projectId: id });
    setLocationPref({
      mode: id ? "project" : "folder",
      projectId: id ?? selectedProjectId ?? locationPref?.projectId ?? null,
    });
  };
  const [step, setStep] = useState<"config" | "context">("config");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [createEffort, setCreateEffort] = useState<Effort | null>(null);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<AgentType>(() => {
    const preferred = initialAgentType ?? readLastUsedAgentType();
    return preferred && enabledAgentTypes.includes(preferred)
      ? preferred
      : enabledAgentTypes.includes("claude") || enabledAgentTypes.length === 0
        ? "claude"
        : enabledAgentTypes[0]!;
  });
  const [folderCwd, setCreateCwd] = useState(() => {
    const resolved = resolveDefaultCwd().trim();
    return resolved || readLastUsedCwd();
  });
  const sourceInitialized = useRef<string | null>(null);
  const folderEdited = useRef(false);
  useEffect(() => {
    if (sourceInitialized.current === sourceAgentId || folderEdited.current)
      return;
    if (sourceAgentId && launch.projection.data) {
      sourceInitialized.current = sourceAgentId;
      setCreateCwd(launch.projection.data.directory);
    }
  }, [sourceAgentId, launch.projection.data]);
  const createCwd =
    project?.repoRoot ??
    (sourceAgentId && launch.projection.isPending ? "" : folderCwd);
  const [createCwdInitialized, setCreateCwdInitialized] = useState(
    () => createCwd.trim().length > 0
  );
  const [createWorktreeBranch, setCreateWorktreeBranch] = useState("");
  const [validatedCwd, setValidatedCwd] = useState<ValidatedCwd | null>(null);
  const validatedCwdRef = useRef<ValidatedCwd | null>(null);
  const [initialPrompt, setInitialPrompt] = useState("");
  const {
    attachmentError,
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
  const [submitError, setSubmitError] = useState<unknown>();
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    add: addCwdHistory,
    remove: removeCwdHistory,
  } = useCwdHistory();
  const targetData = useLaunchTargetData(launch.target, {
    directory: createCwd,
    projectId: createProjectId,
    agentType: createType,
  });
  const {
    persona: createPersona,
    setPersona: setCreatePersona,
    fullAccess: savedCreateFullAccess,
    setFullAccess: setCreateFullAccess,
    useWorktree: createUseWorktree,
    setUseWorktree: setCreateUseWorktree,
    baseBranch: createBaseBranch,
    setBaseBranch: setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
    model: createModel,
    setModel: setCreateModel,
  } = useCreateAgentPrefs(
    targetData.data?.defaults.preferenceKey ?? createCwd,
    createType,
    targetData.data?.defaults.baseBranch ?? "main"
  );
  const createFullAccess = createType === "opencode" || savedCreateFullAccess;
  const {
    options: modelOptions,
    defaultModel,
    loading: modelCatalogLoading,
    loaded: modelCatalogLoaded,
  } = useAgentModelCatalog(createType, true, {
    data: targetData.data?.catalog,
    loading: launch.list.isLoading || targetData.isLoading,
  });
  const agentTypes = targetData.data?.agentTypes ?? enabledAgentTypes;
  const effortData = useLaunchTargetData(
    launch.target,
    {
      directory: createCwd,
      projectId: createProjectId,
      agentType: createType,
      model: createModel,
    },
    Boolean(createModel && createModel !== defaultModel)
  );
  const workloadEffort =
    createModel && createModel !== defaultModel
      ? effortData.data?.effort
      : targetData.data?.effort;

  useEffect(() => {
    if (!modelCatalogLoaded || modelOptions.length === 0) return;
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

  const { data: systemDefaults, isError: systemDefaultsError } =
    useSystemDefaults();
  useEffect(() => {
    if (createCwdInitialized || sourceAgentId) return;
    if (systemDefaults) {
      setCreateCwd(systemDefaults.homeDir);
      setCreateCwdInitialized(true);
    } else if (systemDefaultsError) {
      setCreateCwdInitialized(true);
    }
  }, [
    createCwdInitialized,
    sourceAgentId,
    systemDefaults,
    systemDefaultsError,
  ]);

  useEffect(() => {
    if (agentTypes.includes(createType)) return;
    setCreateType(agentTypes[0] ?? "claude");
  }, [createType, agentTypes]);

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

  const handlePathInfoChange = useCallback(
    (info: CwdPathInfo | null) => {
      const nextValidatedCwd = info
        ? { cwd: createCwd.trim(), isGitRepo: info.isGitRepo }
        : null;
      validatedCwdRef.current = nextValidatedCwd;
      setValidatedCwd(nextValidatedCwd);
    },
    [createCwd]
  );

  useEffect(() => {
    if (!createProjectId || (project && "repository" in project)) return;
    const controller = new AbortController();
    void api<CwdPathInfo>(
      `/api/v1/system/path-info?path=${encodeURIComponent(createCwd.trim())}`,
      { signal: controller.signal }
    )
      .then((info) => {
        if (!controller.signal.aborted) handlePathInfoChange(info);
      })
      .catch(() => {
        if (!controller.signal.aborted) handlePathInfoChange(null);
      });
    return () => controller.abort();
  }, [createProjectId, createCwd, handlePathInfoChange, project]);
  const currentCwd = createCwd.trim();
  const worktreeAvailable =
    Boolean(project && "repository" in project && project.repository) ||
    (validatedCwd?.cwd === currentCwd && validatedCwd.isGitRepo);

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
    setSubmitError(undefined);
    setStep("context");
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const cwd = createCwd.trim();
      if (!cwd || !locationReady) return;

      setCreating(true);
      setSubmitError(undefined);
      try {
        const latestPathInfo = validatedCwdRef.current;
        const submitUseWorktree =
          ((project &&
            "repository" in project &&
            Boolean(project.repository)) ||
            (latestPathInfo?.cwd === cwd && latestPathInfo.isGitRepo)) &&
          createUseWorktree;
        const submitCreateNewBranch = submitUseWorktree && createNewBranch;
        const contextInitialPrompt =
          step === "context" ? initialPrompt.trim() || undefined : undefined;
        const payloadBase = {
          ...launch.target?.launchFields,
          name: createName.trim(),
          cwd: createProjectId ? undefined : cwd,
          projectId: createProjectId ?? undefined,
          type: createType,
          persona: createPersona ?? undefined,
          model: modelOptions.some((option) => option.id === createModel)
            ? createModel
            : undefined,
          effort: createEffort ?? undefined,
          fullAccess: createFullAccess,
          useWorktree: submitUseWorktree,
          createNewBranch: submitUseWorktree
            ? submitCreateNewBranch
            : undefined,
          worktreeBranch: submitCreateNewBranch
            ? createWorktreeBranch.trim() || undefined
            : undefined,
          baseBranch:
            submitUseWorktree &&
            createBaseBranch !==
              (targetData.data?.defaults.baseBranch ?? "main")
              ? createBaseBranch
              : undefined,
          initialPrompt: contextInitialPrompt,
          taskId: task?.id,
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
        setSubmitError(err ?? new Error("The agent wasn’t created."));
      } finally {
        setCreating(false);
      }
    },
    [
      createBaseBranch,
      launch.target?.launchFields,
      targetData.data?.defaults.baseBranch,
      project,
      locationReady,
      createCwd,
      createProjectId,
      createFullAccess,
      createName,
      createModel,
      createEffort,
      createPersona,
      createNewBranch,
      createType,
      createUseWorktree,
      createWorktreeBranch,
      initialPrompt,
      addCwdHistory,
      onCreated,
      task,
      startupFiles,
      startupLinks,
      step,
      modelOptions,
    ]
  );

  return {
    launch,
    targetData,
    agentTypes,
    workloadEffort,
    engines: targetData.data?.engineOptions ?? null,
    chooseTarget: (key: string) => {
      launch.choose(key);
      setCreateEffort(null);
    },
    submitError,
    createProjectId,
    locationReady,
    lastProjectId: locationPref?.projectId,
    setCreateProjectId,
    step,
    setStep,
    promptTextareaRef,
    createName,
    setCreateName,
    createType,
    setCreateType: (type: AgentType) => {
      setCreateType(type);
      setCreateEffort(null);
    },
    createCwd,
    setCreateCwd: (value: string) => {
      folderEdited.current = true;
      setCreateCwd(value);
    },
    createUseWorktree,
    setCreateUseWorktree,
    createWorktreeBranch,
    setCreateWorktreeBranch,
    initialPrompt,
    setInitialPrompt,
    attachmentError,
    startupFiles,
    startupLinks,
    draggingFiles,
    setDraggingFiles,
    contextDraftInvalid,
    setContextDraftInvalid,
    creating,
    createFullAccess,
    setCreateFullAccess,
    createPersona,
    setCreatePersona,
    createModel,
    createEffort,
    setCreateEffort,
    setCreateModel: (model: string | null) => {
      setCreateModel(model);
      setCreateEffort(null);
    },
    modelOptions,
    defaultModel,
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
