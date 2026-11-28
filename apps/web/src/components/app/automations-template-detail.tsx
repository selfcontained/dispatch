import { useTemplateTarget } from "./use-template-target";
import { useProjects } from "@/hooks/use-projects";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Copy, FormInput, Play, Trash2 } from "lucide-react";

import { TemplateConfigFields } from "@/components/app/automations-form-fields";
import { DuplicateTemplateDialog } from "@/components/app/duplicate-template-dialog";
import { LaunchTemplateDialog } from "@/components/app/automations-launch-dialog";
import {
  templateConfigFromDraft,
  templateDraftFrom,
  useTemplateDraft,
} from "@/components/app/automations-template-draft";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import type { AgentType } from "@/lib/agent-types";
import { shortPath } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Button } from "@/components/ui/button";
import { Card, Panel } from "@/components/ui/card";
import { PageContent, PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import {
  useTemplates,
  useTemplateActions,
  parseTemplateArgs,
  type Template,
} from "@/hooks/use-templates";

export function TemplateDetailPane({
  enabledAgentTypes,
}: {
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  const { templateId } = useParams<{ templateId?: string }>();
  const query = useTemplates();
  const template = useMemo(
    () => query.data?.find((t) => t.id === templateId) ?? null,
    [query.data, templateId]
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {template ? null : <PageHeader title="Templates" />}
      <AsyncBoundary query={query} thing="templates" className="m-4">
        {() =>
          template ? (
            <TemplateDetail
              template={template}
              enabledAgentTypes={enabledAgentTypes}
            />
          ) : templateId ? (
            <EmptyState
              title="Template not found"
              description="It may have been deleted, or the link may be wrong."
            />
          ) : (
            <EmptyState
              icon={FormInput}
              title="Select a template"
              description="Its settings and launch arguments show here."
            />
          )
        }
      </AsyncBoundary>
    </div>
  );
}

function TemplateDetail({
  template,
  enabledAgentTypes,
}: {
  template: Template;
  enabledAgentTypes: AgentType[];
}): JSX.Element {
  const navigate = useNavigate();
  const { updateTemplate, removeTemplate, launchTemplate } =
    useTemplateActions();
  const { add: addCwdHistory } = useCwdHistory();

  const { draft, setDraft, fieldProps } = useTemplateDraft(
    templateDraftFrom(template)
  );
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const [locationEdit, setLocationEdit] = useState<{
    id: string;
    projectId: string | null;
    directory: string;
  } | null>(null);
  const hasLocationEdit =
    locationEdit?.id === template.id &&
    (locationEdit.projectId === null ||
      !projectsLoaded ||
      projects.some((p) => p.id === locationEdit.projectId));
  const location = useMemo(
    () =>
      hasLocationEdit
        ? locationEdit!
        : {
            projectId: template.projectId ?? null,
            directory: template.directory,
          },
    [hasLocationEdit, locationEdit, template.projectId, template.directory]
  );
  const target = useTemplateTarget(
    draft,
    setDraft,
    template.id,
    location,
    (directory) =>
      setLocationEdit({
        id: template.id,
        projectId: location.projectId,
        directory,
      })
  );
  const { normalizeModel } = target.models;
  const [saveError, setSaveError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);

  useEffect(() => {
    setDraft(templateDraftFrom(template));
    setSaveError(undefined);
    setSaved(false);
    setDuplicateDialogOpen(false);
    setRemoveDialogOpen(false);
    setLaunchDialogOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const savedArgs = useMemo(
    () => (template.prompt ? parseTemplateArgs(template.prompt) : []),
    [template.prompt]
  );

  const handleLaunch = useCallback(() => {
    setLaunchDialogOpen(true);
  }, []);

  const canSave =
    !!draft.name.trim() &&
    target.launch.selectionReady &&
    (target.launch.target?.location.kind === "project" || location.projectId
      ? Boolean(location.projectId)
      : !!location.directory.trim());

  const handleSave = useCallback(() => {
    setSaveError(undefined);
    setSaved(false);
    updateTemplate
      .mutateAsync({
        id: template.id,
        name: draft.name.trim(),
        model: normalizeModel(draft.model),
        ...templateConfigFromDraft(draft),
        ...target.launch.fields,
        projectId: hasLocationEdit ? location.projectId : undefined,
        directory:
          hasLocationEdit || target.launch.changed
            ? (target.data.data?.defaults.templateFields?.directory ??
              location.directory.trim())
            : undefined,
      })
      .then(() => {
        addCwdHistory(location.directory);
        setLocationEdit(null);
        setSaved(true);
      })
      .catch(setSaveError);
  }, [
    updateTemplate,
    template.id,
    draft,
    normalizeModel,
    addCwdHistory,
    hasLocationEdit,
    location,
    target.launch.fields,
    target.launch.changed,
    target.data.data?.defaults.templateFields,
  ]);

  const handleDelete = useCallback(async () => {
    await removeTemplate.mutateAsync(template.id);
    setRemoveDialogOpen(false);
    navigate("/automations");
    toast.success(`Template “${template.name}” deleted.`);
  }, [removeTemplate, template, navigate]);

  return (
    <>
      <PageHeader
        title={template.name}
        description={
          <span
            title={
              template.description ||
              target.launch.projection.data?.locationLabel
            }
          >
            {template.description ||
              shortPath(target.launch.projection.data?.locationLabel ?? "")}
          </span>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="primary"
              pending={launchTemplate.isPending}
              onClick={handleLaunch}
            >
              <Play className="fill-current" />
              Launch
            </Button>
            <Button size="sm" onClick={() => setDuplicateDialogOpen(true)}>
              <Copy />
              Duplicate
            </Button>
          </>
        }
      />
      <PageContent className="space-y-4">
        {template.description ? (
          <p className="break-all font-mono text-body-sm text-muted-foreground">
            {shortPath(target.launch.projection.data?.locationLabel ?? "")}
          </p>
        ) : null}
        {savedArgs.length > 0 ? (
          <Panel className="text-body-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Launch arguments:
            </span>{" "}
            {savedArgs.map((a, i) => (
              <span key={a.key}>
                {i > 0 ? ", " : ""}
                <span className="rounded-sm bg-surface-selected px-1.5 py-0.5 text-primary">
                  {a.name}
                  {a.required ? " *" : ""}
                  {a.multiline ? " (multiline)" : ""}
                </span>
              </span>
            ))}
          </Panel>
        ) : null}

        <Card className="p-4">
          <h2 className="text-heading-sm">Template configuration</h2>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Agent launch settings for this template.
          </p>
          <div className="mt-4">
            <TemplateConfigFields
              {...fieldProps}
              target={target}
              projectId={location.projectId}
              directory={location.directory}
              onProjectChange={(projectId, directory) =>
                setLocationEdit({ id: template.id, projectId, directory })
              }
              onDirectoryChange={(directory) =>
                setLocationEdit({
                  id: template.id,
                  projectId: null,
                  directory,
                })
              }
              enabledAgentTypes={enabledAgentTypes}
            />
          </div>

          {saveError ? (
            <Alert
              title="Couldn’t save the template."
              error={saveError}
              className="mt-4"
            />
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-3">
            {saved ? (
              <span
                role="status"
                className="text-body-sm text-muted-foreground"
              >
                Saved.
              </span>
            ) : null}
            <Button
              variant="primary"
              pending={updateTemplate.isPending}
              disabled={!canSave}
              onClick={handleSave}
            >
              Save
            </Button>
          </div>
        </Card>

        <Card variant="panel" tone="danger" className="p-4">
          <h2 className="text-heading-sm text-danger">Delete template</h2>
          <p className="mt-1 text-body-sm text-muted-foreground">
            Permanently remove this template. Jobs that reference it will lose
            their backing template.
          </p>
          <div className="mt-3 flex justify-end">
            <Button
              variant="danger"
              size="sm"
              disabled={removeTemplate.isPending}
              onClick={() => setRemoveDialogOpen(true)}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </Card>
      </PageContent>

      <ConfirmDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        title={`Delete “${template.name}”?`}
        description="This cannot be undone."
        confirmLabel="Delete template"
        errorTitle="Couldn’t delete the template."
        onConfirm={handleDelete}
      />
      <DuplicateTemplateDialog
        key={template.id}
        template={template}
        open={duplicateDialogOpen}
        onOpenChange={setDuplicateDialogOpen}
      />
      <LaunchTemplateDialog
        template={template}
        open={launchDialogOpen}
        onOpenChange={setLaunchDialogOpen}
        agentTypes={enabledAgentTypes}
      />
    </>
  );
}
