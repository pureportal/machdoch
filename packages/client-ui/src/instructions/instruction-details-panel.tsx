import type { JSX, ReactNode } from "react";
import {
  MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_PROFILE_NAME_LENGTH,
} from "@machdoch/fleet-protocol/instruction-limits";
import type { InstructionTagRule } from "@machdoch/fleet-protocol/instruction-contract";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { SegmentedControl } from "./instruction-controls";
import { ACTIVATION_ICONS } from "./instruction-file-list";
import type {
  InstructionActivation,
  InstructionWorkspaceReach,
} from "./instruction-library-model";
import { TagEditor } from "./tag-editor";
import { TagRuleEditor } from "./tag-rule-editor";

const ACTIVATION_OPTIONS = [
  { value: "global", label: "Everywhere" },
  { value: "tag-match", label: "By tag" },
  { value: "manual", label: "Manual" },
] as const;

const DetailSection = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}): JSX.Element => (
  <section className="grid content-start gap-2.5 border-b border-slate-900 px-4 py-4 xl:last:border-b-0">
    <div className="flex min-w-0 items-center justify-between gap-2">
      <h3 className="text-xs font-medium text-slate-400">{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);

export const InstructionDetailsPanel = ({
  name,
  description,
  activation,
  match,
  tags,
  reach,
  workspaceCount,
  formDisabled,
  activationLocked,
  nameInvalid,
  descriptionInvalid,
  matchInvalid,
  tagDraftPending,
  validationErrorId,
  pendingTagMessageId,
  onNameChange,
  onDescriptionChange,
  onActivationChange,
  onMatchChange,
  onTagsChange,
  onTagDraftPendingChange,
}: {
  name: string;
  description: string;
  activation: InstructionActivation;
  match: InstructionTagRule | null;
  tags: string[];
  reach: readonly InstructionWorkspaceReach[];
  workspaceCount: number;
  formDisabled: boolean;
  activationLocked: boolean;
  nameInvalid: boolean;
  descriptionInvalid: boolean;
  matchInvalid: boolean;
  tagDraftPending: boolean;
  validationErrorId: string;
  pendingTagMessageId: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onActivationChange: (value: InstructionActivation) => void;
  onMatchChange: (value: InstructionTagRule) => void;
  onTagsChange: (value: string[]) => void;
  onTagDraftPendingChange: (pending: boolean) => void;
}): JSX.Element => (
  <div className="grid min-w-0 content-start md:grid-cols-2 xl:grid-cols-1">
    <DetailSection title="Details">
      <label className="grid gap-1.5 text-xs text-slate-500">
        Name
        <Input
          value={name}
          maxLength={MAX_INSTRUCTION_PROFILE_NAME_LENGTH * 2}
          disabled={formDisabled}
          aria-invalid={nameInvalid}
          aria-describedby={nameInvalid ? validationErrorId : undefined}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-9 border-slate-800 bg-slate-950"
        />
      </label>
      <label className="grid gap-1.5 text-xs text-slate-500">
        Description
        <Textarea
          value={description}
          rows={2}
          maxLength={MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH * 2}
          disabled={formDisabled}
          aria-invalid={descriptionInvalid}
          aria-describedby={descriptionInvalid ? validationErrorId : undefined}
          onChange={(event) => onDescriptionChange(event.target.value)}
          className="min-h-16 resize-y border-slate-800 bg-slate-950 text-sm"
        />
      </label>
    </DetailSection>

    <DetailSection title="Applies to">
      <SegmentedControl
        label="Applies to"
        value={activation}
        options={ACTIVATION_OPTIONS}
        disabled={formDisabled || activationLocked}
        className="flex w-full"
        onChange={onActivationChange}
      />
      {activationLocked ? (
        <p className="text-xs text-slate-500">
          Remove its workspace assignments to change this or delete the file.
        </p>
      ) : null}
      {activation === "tag-match" && match ? (
        <TagRuleEditor
          value={match}
          disabled={formDisabled}
          errorId={matchInvalid ? validationErrorId : undefined}
          onChange={onMatchChange}
        />
      ) : null}
    </DetailSection>

    <DetailSection
      title="Workspaces"
      aside={
        workspaceCount > 0 ? (
          <span className="text-xs tabular-nums text-slate-500">
            {reach.length}/{workspaceCount}
          </span>
        ) : null
      }
    >
      {reach.length === 0 ? (
        <p className="text-sm text-slate-500">None</p>
      ) : (
        <ul className="grid gap-1">
          {reach.map(({ workspace, name: workspaceName, via }) => {
            const Icon = ACTIVATION_ICONS[via];
            return (
              <li
                key={workspace.id}
                title={workspace.root}
                className="flex min-w-0 items-center gap-2 text-sm text-slate-300"
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    via === "manual" ? "text-slate-500" : "text-sky-300/80",
                  )}
                />
                <span className="truncate">{workspaceName}</span>
              </li>
            );
          })}
        </ul>
      )}
    </DetailSection>

    <DetailSection title="Tags">
      <TagEditor
        value={tags}
        disabled={formDisabled}
        onChange={onTagsChange}
        onPendingChange={onTagDraftPendingChange}
      />
      {tagDraftPending ? (
        <p id={pendingTagMessageId} className="text-xs text-slate-500">
          Add or clear the pending tag before saving.
        </p>
      ) : null}
    </DetailSection>
  </div>
);
