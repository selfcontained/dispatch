import {
  useRunnerEngineInventory,
  useRunnerModelCatalog,
} from "@/hooks/use-runner-engines";
import { isLocalFolder } from "./path-input-utils";
import { MANAGED_WORKSPACE, validBranch } from "@dispatch/runner-protocol";
import { useQueries } from "@tanstack/react-query";

import type { Effort } from "@dispatch/shared";
import { useAtom } from "jotai";
import { useProjects } from "@/hooks/use-projects";
import { createAgentLocationPrefAtom } from "@/lib/store";
import { runnerLocator, useRunners } from "@/hooks/use-runners";
import {
  type ClipboardEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
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

export function isPullRequestUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(
    value.trim()
  );
}

const FRESH_CHECKOUT = { baseBranch: "", createNewBranch: true };

type ValidatedCwd = CwdPathInfo & {
  cwd: string;
};

export function useCreateAgentForm({
  enabledAgentTypes,
  initialAgentType,
  resolveDefaultCwd,
  initialProjectId,
  task = null,
  onCreated,
}: UseCreateAgentFormOptions) {
  // A null runner selects this computer.
  const { data: runners = [] } = useRunners({ poll: true });
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const runner = runners.find((r) => r.id === runnerId);
  // A remote choice never silently becomes local: a revoked or missing runner
  // stays selected as unavailable and blocks launch until the user switches.
  const remote = Boolean(runnerId);
  const runnerUnavailable = remote && (!runner || runner.status === "revoked");
  const online = runner?.status === "online";
  // Persona lookup still uses the runner's internal session locator.
  const remoteCwd =
    runnerId && online ? runnerLocator(runnerId, MANAGED_WORKSPACE) : "";
  const selectRunner = (id: string | null) => {
    if (id === runnerId) return;
    setCreateEffort(null);
    setRunnerProjectId(null);
    resetRepositoryCheckout();
    setRunnerId(id);
  };
  const [locationPref, setLocationPref] = useAtom(createAgentLocationPrefAtom);
  const {
    data: projects = [],
    isSuccess: projectsLoaded,
    isError: projectsError,
  } = useProjects();
  // The scope seeds this opening, but a picker choice (including Folder)
  // belongs to the mounted form and must survive preference hydration/rerenders.
  const [locationChoice, setLocationChoice] = useState<{
    projectId: string | null;
  } | null>(null);
  const [runnerProjectId, setRunnerProjectId] = useState<string | null>(null);
  const selectedProjectId = task
    ? task.projectId
    : remote
      ? runnerProjectId
      : locationChoice
        ? locationChoice.projectId
        : (initialProjectId ??
          (locationPref?.mode === "project" ? locationPref.projectId : null));
  const project = projects.find((p) => p.id === selectedProjectId);
  const projectCandidates =
    remote && !runnerUnavailable
      ? projects.filter((p) => !task || p.id === task.projectId)
      : [];
  const origins = useQueries({
    queries: projectCandidates.map(({ id }) => ({
      queryKey: ["runner-project-origin", id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ url: string | null }>(
          `/api/v1/projects/${encodeURIComponent(id)}/repository`,
          { signal }
        ),
      staleTime: 30_000,
    })),
  });
  const runnerProjects = projectCandidates.flatMap((candidate, index) =>
    origins[index]?.data?.url ? [candidate] : []
  );
  const repository = project
    ? (origins[projectCandidates.indexOf(project)]?.data?.url ?? "")
    : "";
  const createProjectId = remote
    ? repository
      ? (project?.id ?? null)
      : null
    : projectsLoaded
      ? (project?.id ?? null)
      : selectedProjectId;
  const setCreateProjectId = (id: string | null) => {
    if (remote) {
      if (id === runnerProjectId) return;
      setRunnerProjectId(id);
      resetRepositoryCheckout();
      return;
    }
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
    return isLocalFolder(resolved) ? resolved : readLastUsedCwd();
  });
  const createCwd = remote ? remoteCwd : (project?.repoRoot ?? folderCwd);
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
  const {
    persona: createPersona,
    setPersona: setCreatePersona,
    fullAccess: savedCreateFullAccess,
    setFullAccess: setCreateFullAccess,
    useWorktree: savedUseWorktree,
    setUseWorktree: setCreateUseWorktree,
    baseBranch: savedBaseBranch,
    setBaseBranch: setSavedBaseBranch,
    createNewBranch: savedCreateNewBranch,
    setCreateNewBranch: setSavedCreateNewBranch,
    model: nativeModel,
    setModel: setNativeModel,
  } = useCreateAgentPrefs(
    createCwd,
    createType,
    remote ? createProjectId : null
  );
  // One checkout choice for both placements. A local folder remembers it per
  // folder; a runner repository starts on its default branch each time.
  const [repositoryChoice, setRepositoryChoice] = useState(FRESH_CHECKOUT);
  const resetRepositoryCheckout = () => {
    setRepositoryChoice(FRESH_CHECKOUT);
    setCreateWorktreeBranch("");
  };
  // A managed repository checkout always uses a worktree.
  const worktreeOptional = !remote;
  const createUseWorktree = worktreeOptional ? savedUseWorktree : true;
  const selectedBaseBranch = worktreeOptional
    ? savedBaseBranch || "main"
    : repositoryChoice.baseBranch;
  const createNewBranch = worktreeOptional
    ? savedCreateNewBranch
    : repositoryChoice.createNewBranch;
  const createBaseBranch =
    remote && createNewBranch && isPullRequestUrl(selectedBaseBranch)
      ? ""
      : selectedBaseBranch;
  const setCreateBaseBranch = (baseBranch: string) =>
    worktreeOptional
      ? setSavedBaseBranch(baseBranch)
      : setRepositoryChoice((choice) => ({ ...choice, baseBranch }));
  const setCreateNewBranch = (createNewBranch: boolean) =>
    worktreeOptional
      ? setSavedCreateNewBranch(createNewBranch)
      : setRepositoryChoice((choice) => ({ ...choice, createNewBranch }));
  const branchReady = createNewBranch
    ? (!createBaseBranch || validBranch(createBaseBranch.trim())) &&
      (!createWorktreeBranch.trim() || validBranch(createWorktreeBranch.trim()))
    : !createBaseBranch.trim() ||
      validBranch(createBaseBranch.trim()) ||
      (runner?.githubManagement === true && isPullRequestUrl(createBaseBranch));
  const locationReady = runnerId
    ? online && Boolean(createProjectId) && branchReady
    : isLocalFolder(createCwd) && (!selectedProjectId || projectsLoaded);
  const createFullAccess = createType === "opencode" || savedCreateFullAccess;
  const {
    options: nativeOptions,
    loading: nativeLoading,
    loaded: nativeLoaded,
    defaultModel: nativeDefault,
  } = useAgentModelCatalog(createType, !remote);
  const inventory = useRunnerEngineInventory(
    runnerId ? { kind: "runner", runnerId } : { kind: "local" },
    online && runner?.engineManagement === true
  );
  const runnerEnginesLoading = Boolean(
    remote && online && runner?.engineManagement && inventory.isLoading
  );
  const entries =
    online && !inventory.isError ? inventory.data?.entries : undefined;
  const runnableTypes = entries
    ?.filter((entry) => entry.installed && entry.signedIn !== false)
    .map((entry) => entry.id);
  const agentTypes = remote
    ? (runnableTypes ?? enabledAgentTypes)
    : enabledAgentTypes;
  const runnerEngineBlocked = Boolean(
    remote && runnableTypes && !runnableTypes.includes(createType)
  );
  const [runnerModels, setRunnerModels] = useState<
    Record<string, string | null>
  >({});
  const modelKey = JSON.stringify([runnerId, createType]);
  const createModel = remote ? (runnerModels[modelKey] ?? null) : nativeModel;
  const catalog = useRunnerModelCatalog(runnerId, createType, online);
  const currentCatalog = online && !catalog.isError ? catalog.data : undefined;
  const modelOptions = useMemo(
    () => (remote ? (currentCatalog?.models ?? []) : nativeOptions),
    [remote, currentCatalog, nativeOptions]
  );
  const modelCatalogLoading = remote ? catalog.isLoading : nativeLoading;
  const reportedDefault = remote ? currentCatalog?.defaultModel : nativeDefault;
  const defaultModel = modelOptions.some(
    (option) => option.id === reportedDefault
  )
    ? (reportedDefault ?? null)
    : null;
  const selectedModel =
    createModel &&
    currentCatalog?.models.some((option) => option.id === createModel)
      ? createModel
      : undefined;
  const selectedEffortCatalog = useRunnerModelCatalog(
    runnerId,
    createType,
    online &&
      Boolean(selectedModel && selectedModel !== currentCatalog?.defaultModel),
    selectedModel
  );
  const effortCatalog =
    selectedModel && selectedModel !== currentCatalog?.defaultModel
      ? !selectedEffortCatalog.isError
        ? selectedEffortCatalog.data
        : undefined
      : currentCatalog;
  const workloadEffort = effortCatalog?.models.find(
    (option) => option.id === (selectedModel ?? currentCatalog?.defaultModel)
  )?.effort;

  useEffect(() => {
    if (remote || !nativeLoaded || nativeOptions.length === 0) return;
    // Anything stored that the catalog no longer offers (a retired id, or an
    // empty string persisted by an older build) resets to the CLI default.
    if (
      createModel !== null &&
      !modelOptions.some((option) => option.id === createModel)
    ) {
      setNativeModel(null);
    }
  }, [
    createModel,
    remote,
    nativeLoaded,
    nativeOptions,
    modelOptions,
    setNativeModel,
  ]);

  useEffect(() => {
    setCreateWorktreeBranch("");
  }, [createCwd]);

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
    if (agentTypes.includes(createType) || !agentTypes.length) return;
    setCreateType(agentTypes[0]!);
    setCreateEffort(null);
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
    if (!createProjectId || remote) return;
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
  }, [createProjectId, createCwd, handlePathInfoChange, remote]);
  const currentCwd = createCwd.trim();
  const worktreeAvailable =
    !worktreeOptional ||
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
      if (
        (!remote && !cwd) ||
        !locationReady ||
        runnerEnginesLoading ||
        runnerEngineBlocked
      )
        return;

      setCreating(true);
      setSubmitError(undefined);
      try {
        const latestPathInfo = validatedCwdRef.current;
        const base = createBaseBranch.trim();
        // A pull request URL opens its source branch; the server resolves it.
        const pullRequest =
          remote && !createNewBranch && isPullRequestUrl(base);
        const submitUseWorktree =
          remote ||
          (latestPathInfo?.cwd === cwd &&
            latestPathInfo.isGitRepo &&
            createUseWorktree);
        const submitCreateNewBranch = submitUseWorktree && createNewBranch;
        const contextInitialPrompt =
          step === "context" ? initialPrompt.trim() || undefined : undefined;
        const payloadBase = {
          name: createName.trim(),
          cwd: remote || createProjectId ? undefined : cwd,
          runner: runnerId ?? undefined,
          projectId: createProjectId ?? undefined,
          type: createType,
          persona: createPersona ?? undefined,
          model: modelOptions.some((option) => option.id === createModel)
            ? createModel
            : undefined,
          effort:
            !remote ||
            workloadEffort?.some((choice) => choice.value === createEffort)
              ? (createEffort ?? undefined)
              : undefined,
          fullAccess: createFullAccess,
          useWorktree: submitUseWorktree,
          createNewBranch: submitUseWorktree
            ? submitCreateNewBranch
            : undefined,
          worktreeBranch: submitCreateNewBranch
            ? createWorktreeBranch.trim() || undefined
            : undefined,
          baseBranch:
            submitUseWorktree && !pullRequest ? base || undefined : undefined,
          pullRequest: submitUseWorktree && pullRequest ? base : undefined,
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
                formData.append(
                  key,
                  typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value)
                );
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
          if (!remote) window.localStorage.setItem(LAST_USED_CWD_KEY, cwd);
          window.localStorage.setItem(LAST_USED_TYPE_KEY, createType);
        }
        if (!remote) addCwdHistory(cwd);
        await onCreated(payload.agent, createType);
      } catch (err) {
        setSubmitError(err ?? new Error("The agent wasn’t created."));
      } finally {
        setCreating(false);
      }
    },
    [
      createBaseBranch,
      runnerId,
      locationReady,
      runnerEngineBlocked,
      runnerEnginesLoading,
      createCwd,
      remote,
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
      workloadEffort,
    ]
  );

  return {
    runners,
    agentTypes,
    runnerEngineBlocked,
    runnerId,
    runnerEnginesLoading,
    runnerUnavailable,
    repository,
    runnerProjects,
    runnerProjectsLoading:
      (!projectsLoaded && !projectsError) ||
      origins.some((origin) => origin.isPending),
    runnerProjectsError:
      projectsError || origins.some((origin) => origin.isError),
    selectRunner,
    submitError,
    createProjectId,
    locationReady:
      locationReady && !runnerEnginesLoading && !runnerEngineBlocked,
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
    setCreateCwd,
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
      if (remote)
        setRunnerModels((current) => ({ ...current, [modelKey]: model }));
      else setNativeModel(model);
      setCreateEffort(null);
    },
    modelOptions,
    defaultModel,
    modelCatalogLoading,
    workloadEffort,
    workloadCatalogUnavailable:
      remote && !modelCatalogLoading && !modelOptions.length,
    createBaseBranch,
    setCreateBaseBranch,
    createNewBranch,
    setCreateNewBranch,
    cwdHistory,
    removableCwdHistory,
    cwdHistoryMetadata,
    removeCwdHistory,
    worktreeAvailable,
    worktreeOptional,
    checkoutVisible: !remote || Boolean(repository),
    pullRequests: remote && runner?.githubManagement === true,
    branchSource:
      runnerId && repository ? { id: runnerId, repository } : undefined,
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
