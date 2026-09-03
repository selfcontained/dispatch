import { useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  makeIdempotencyKey,
  useSubmitSurfaceInteraction,
} from "@/hooks/use-agent-surfaces";
import type { FormBlock } from "@/components/app/agent-surfaces/types";
import { BlockHeader } from "@/components/app/agent-surfaces/blocks/block-header";
import { FormFieldControl } from "@/components/app/agent-surfaces/blocks/form-fields";
import { ActionRefButton } from "@/components/app/agent-surfaces/blocks/action-ref-button";
import { ActionConfirmDialog } from "@/components/app/agent-surfaces/blocks/action-confirm-dialog";
import {
  ActionFeedback,
  showsDisabledReason,
} from "@/components/app/agent-surfaces/blocks/interaction-status-caption";
import { useSingleInteractionState } from "@/components/app/agent-surfaces/local-interaction-state";
import {
  findInteraction,
  resolveInteractionPresentation,
  type SurfaceInteractionIndex,
} from "@/components/app/agent-surfaces/interaction-presentation";
import { useSurfaceFormDraft } from "@/components/app/agent-surfaces/use-surface-form-draft";
import {
  mergeFormValues,
  validateFormValues,
  type FormValues,
} from "@/components/app/agent-surfaces/form-validation";

export function FormBlockView({
  block,
  agentId,
  surfaceId,
  surfaceRevision,
  interactions,
  onRequestRefresh,
  readOnly,
  idPrefix,
}: {
  block: FormBlock;
  agentId: string;
  surfaceId: string;
  surfaceRevision: number;
  interactions: SurfaceInteractionIndex;
  onRequestRefresh: () => Promise<void>;
  readOnly: boolean;
  idPrefix: string;
}): JSX.Element {
  const [draft, setDraft] = useSurfaceFormDraft(agentId, surfaceId, block.id);
  const values = useMemo(
    () => mergeFormValues(block.fields, draft),
    [block.fields, draft]
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const mutation = useSubmitSurfaceInteraction(agentId, surfaceId);
  const {
    state: submitState,
    reset: resetSubmitState,
    submit,
  } = useSingleInteractionState(surfaceRevision, mutation.mutate);
  const submitMode = block.submitMode ?? "once";
  // A once-form stays locked after a *completed* submission because the
  // server's partial unique index still covers `completed`; a rejected,
  // cancelled or orphaned one falls outside that index and re-arms, so the
  // user can correct and resubmit rather than be told to try again by a
  // button that cannot work. See interaction-presentation.ts.
  const presentation = resolveInteractionPresentation({
    local: submitState,
    durable: findInteraction(interactions, block.id, block.submit.id),
    surfaceRevision,
    mode: submitMode === "repeatable" ? "form-repeatable" : "form-once",
    readOnly,
  });
  const inputsLocked = presentation.locked || presentation.busy;
  const authoredDisabled = !readOnly && !!block.submit.disabled;
  const disabledReasonId = `${idPrefix}-${block.id}-submit-disabled-reason`;
  const showsReason = showsDisabledReason(
    presentation.caption,
    authoredDisabled,
    block.submit.disabledReason
  );

  const setFieldValue = (fieldId: string, value: FormValues[string]) => {
    setDraft({ ...values, [fieldId]: value });
    if (errors[fieldId]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[fieldId];
        return next;
      });
    }
  };

  const handleReset = () => {
    setDraft(null);
    setErrors({});
  };

  const doSubmit = () => {
    submit(
      {
        idempotencyKey: makeIdempotencyKey(),
        kind: "form_submit",
        blockId: block.id,
        actionId: block.submit.id,
        values,
        baseRevision: surfaceRevision,
      },
      "Couldn't submit this form",
      () => setDraft(null)
    );
  };

  // Trailing consecutive checkbox fields form the attestation group.
  let attestationStart = block.fields.length;
  while (
    attestationStart > 0 &&
    block.fields[attestationStart - 1].type === "checkbox"
  )
    attestationStart -= 1;
  const hasAttestationGroup =
    attestationStart < block.fields.length && attestationStart > 0;
  const leadingFields = hasAttestationGroup
    ? block.fields.slice(0, attestationStart)
    : block.fields;
  const attestationFields = hasAttestationGroup
    ? block.fields.slice(attestationStart)
    : [];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (inputsLocked || authoredDisabled) return;
    const nextErrors = validateFormValues(block.fields, values);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    if (block.submit.confirm) {
      setConfirming(true);
      return;
    }
    doSubmit();
  };

  return (
    <form
      data-block-id={block.id}
      data-block-type="form"
      onSubmit={handleSubmit}
      noValidate
      className="space-y-3"
    >
      <BlockHeader title={block.title} description={block.description} />
      <fieldset disabled={inputsLocked} className="space-y-3">
        {leadingFields.map((field) => (
          <FormFieldControl
            key={field.id}
            field={field}
            fieldId={`${idPrefix}-${block.id}-${field.id}`}
            value={values[field.id]}
            error={errors[field.id]}
            onChange={(value) => setFieldValue(field.id, value)}
          />
        ))}
        {attestationFields.length > 0 ? (
          // A trailing run of checkboxes right before the submit reads as a
          // gate ("migrations reviewed", "rollback plan ready") — group it so
          // it doesn't scatter as loose options.
          <div className="space-y-2 rounded-md border border-border/50 p-2.5">
            {attestationFields.map((field) => (
              <FormFieldControl
                key={field.id}
                field={field}
                fieldId={`${idPrefix}-${block.id}-${field.id}`}
                value={values[field.id]}
                error={errors[field.id]}
                onChange={(value) => setFieldValue(field.id, value)}
              />
            ))}
          </div>
        ) : null}
      </fieldset>

      <div className="space-y-1.5">
        {/* A form has exactly one submit; it is by definition the form's
            primary action, and it matches the fields' full width. */}
        <ActionRefButton
          action={block.submit}
          type="submit"
          variantOverride="primary"
          className="w-full"
          busy={presentation.busy}
          disabled={presentation.locked}
          authoredDisabled={authoredDisabled}
          disabledReasonId={showsReason ? disabledReasonId : undefined}
        />
        {block.resetLabel ? (
          <div className="text-right">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={handleReset}
              disabled={inputsLocked}
            >
              {block.resetLabel}
            </Button>
          </div>
        ) : null}
      </div>

      <ActionFeedback
        id={disabledReasonId}
        caption={presentation.caption}
        disabled={authoredDisabled}
        disabledReason={block.submit.disabledReason}
        onReload={() => {
          void onRequestRefresh().then(() => resetSubmitState());
        }}
      />

      <ActionConfirmDialog
        action={confirming ? block.submit : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          doSubmit();
        }}
      />
    </form>
  );
}
