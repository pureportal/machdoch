import {
  Copy,
  FileText,
  Globe2,
  LoaderCircle,
  Save,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import type { JSX } from "react";
import {
  MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_PROFILE_NAME_LENGTH,
  MAX_INSTRUCTION_SOURCE_BYTES,
} from "@machdoch/fleet-protocol/instruction-limits";
import type {
  InstructionProfileView,
  InstructionRegistryResult,
  InstructionTagRule,
} from "@machdoch/fleet-protocol/instruction-contract";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { TagEditor } from "./tag-editor";
import { TagRuleEditor, createEmptyTagGroup } from "./tag-rule-editor";
import type {
  ContentMode,
  InstructionManagementControls,
  InstructionRuntime,
} from "./types";

interface InstructionEditorProps {
  name: string;
  description: string;
  body: string;
  aiRequest: string;
  pendingTagMessageId: string;
  validationErrorId: string;
  contentViewId: string;
  creating: boolean;
  global: boolean;
  dirty: boolean;
  formDisabled: boolean;
  tagDraftPending: boolean;
  hasManualAssignments: boolean;
  nameInvalid: boolean;
  descriptionInvalid: boolean;
  bodyInvalid: boolean;
  enabled: boolean;
  matchInvalid: boolean;
  aiBusy: boolean;
  aiCancelling: boolean;
  saveFile(): Promise<void>;
  duplicateFile(): Promise<void>;
  deleteFile(): Promise<void>;
  cancelAiAssist(): Promise<void>;
  runAiAssist(): Promise<void>;
  selectedFile: InstructionProfileView | null;
  registry: InstructionRegistryResult | null;
  match: InstructionTagRule | null;
  tags: string[];
  validationError: string | null;
  aiError: string | null;
  contentMode: ContentMode;
  setup: InstructionManagementControls;
  runtime: InstructionRuntime;
  discardChanges(): void;
  setName(value: string): void;
  setDescription(value: string): void;
  setEnabled(value: boolean): void;
  setGlobalMode(value: boolean): void;
  setTagDraftPending(value: boolean): void;
  setTags(value: string[]): void;
  setMatch(value: InstructionTagRule | null): void;
  setContentMode(value: ContentMode): void;
  setBody(value: string): void;
  setAiRequest(value: string): void;
}

export function InstructionEditor({
  creating,
  global,
  name,
  selectedFile,
  match,
  tags,
  dirty,
  formDisabled,
  discardChanges,
  tagDraftPending,
  validationError,
  pendingTagMessageId,
  saveFile,
  registry,
  duplicateFile,
  deleteFile,
  hasManualAssignments,
  validationErrorId,
  nameInvalid,
  setName,
  description,
  descriptionInvalid,
  setDescription,
  bodyInvalid,
  enabled,
  setEnabled,
  setGlobalMode,
  setTagDraftPending,
  setTags,
  setMatch,
  matchInvalid,
  body,
  contentMode,
  setContentMode,
  contentViewId,
  aiBusy,
  aiRequest,
  setAiRequest,
  aiCancelling,
  cancelAiAssist,
  runAiAssist,
  aiError,
  setup,
  runtime,
  setBody,
}: InstructionEditorProps): JSX.Element {
  return (
    <SubmitShortcut asChild>
      <div className="mx-auto w-full max-w-7xl space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {global ? (
                <Globe2 className="size-5 text-sky-300" />
              ) : (
                <FileText className="size-5 text-sky-300" />
              )}
              <h2 className="truncate text-base font-semibold text-slate-100">
                {creating
                  ? "New instruction file"
                  : name.trim() || selectedFile?.name}
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {creating || dirty ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={formDisabled}
                onClick={discardChanges}
              >
                {creating ? "Cancel" : "Discard"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={
                formDisabled ||
                tagDraftPending ||
                !dirty ||
                validationError !== null
              }
              aria-describedby={
                tagDraftPending ? pendingTagMessageId : undefined
              }
              onClick={() => void saveFile()}
              {...SUBMIT_SHORTCUT_ACTION_PROPS}
            >
              <Save className="size-4" />
              Save
            </Button>
            {selectedFile && registry ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                disabled={formDisabled || dirty}
                aria-label="Duplicate instruction file"
                tooltip={dirty ? "Save or discard changes first." : undefined}
                onClick={() => void duplicateFile()}
              >
                <Copy className="size-4" />
              </Button>
            ) : null}
            {selectedFile && registry ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={formDisabled || dirty || hasManualAssignments}
                aria-label="Delete instruction file"
                tooltip={
                  dirty
                    ? "Save or discard changes first."
                    : selectedFile.manualAssignmentCount
                      ? "Remove workspace assignments first."
                      : undefined
                }
                onClick={() => void deleteFile()}
              >
                <Trash2 className="size-4 text-red-300" />
              </Button>
            ) : null}
          </div>
        </div>

        {dirty && validationError ? (
          <p
            id={validationErrorId}
            role="alert"
            className="text-sm text-red-300"
          >
            {validationError}
          </p>
        ) : null}

        <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium text-slate-400">
              Name
              <Input
                value={name}
                maxLength={MAX_INSTRUCTION_PROFILE_NAME_LENGTH * 2}
                disabled={formDisabled}
                aria-invalid={nameInvalid}
                aria-describedby={nameInvalid ? validationErrorId : undefined}
                onChange={(event) => setName(event.target.value)}
                className="h-9 border-slate-800 bg-slate-950"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-slate-400">
              Description
              <Input
                value={description}
                maxLength={MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH * 2}
                disabled={formDisabled}
                aria-invalid={descriptionInvalid}
                aria-describedby={
                  descriptionInvalid ? validationErrorId : undefined
                }
                onChange={(event) => setDescription(event.target.value)}
                className="h-9 border-slate-800 bg-slate-950"
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-5">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={global || enabled}
                disabled={formDisabled || global}
                onChange={(event) => setEnabled(event.target.checked)}
                className="accent-sky-500"
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={global}
                disabled={formDisabled || hasManualAssignments}
                onChange={(event) => setGlobalMode(event.target.checked)}
                className="accent-sky-500"
              />
              Global
            </label>
          </div>
          <label className="grid gap-1.5 text-xs font-medium text-slate-400">
            Tags
            <TagEditor
              value={tags}
              disabled={formDisabled}
              onChange={setTags}
              onPendingChange={setTagDraftPending}
            />
          </label>
          {hasManualAssignments ? (
            <p className="text-xs text-slate-500">
              Remove manual workspace assignments before changing the assignment
              mode or deleting this file.
            </p>
          ) : null}
          {tagDraftPending ? (
            <p id={pendingTagMessageId} className="text-xs text-slate-500">
              Add or clear the pending tag before saving.
            </p>
          ) : null}
        </section>

        {!global ? (
          <section className="rounded-xl border border-slate-800 bg-slate-900/20 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-slate-200">
                Workspace tag match
              </h3>
              <label className="flex items-center gap-2 text-sm text-slate-400">
                <input
                  type="checkbox"
                  checked={match !== null}
                  disabled={formDisabled || hasManualAssignments}
                  onChange={(event) =>
                    setMatch(
                      event.target.checked ? createEmptyTagGroup() : null,
                    )
                  }
                  className="accent-sky-500"
                />
                Enabled
              </label>
            </div>
            {match ? (
              <TagRuleEditor
                value={match}
                disabled={formDisabled}
                errorId={matchInvalid ? validationErrorId : undefined}
                onChange={setMatch}
              />
            ) : null}
          </section>
        ) : null}

        <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium text-slate-200">Content</h3>
              <div
                className="inline-flex rounded-md border border-slate-800 bg-slate-950 p-0.5"
                role="tablist"
                aria-label="Instruction content view"
              >
                {(["edit", "preview"] as const).map((mode) => (
                  <button
                    key={mode}
                    id={`${contentViewId}-tab-${mode}`}
                    type="button"
                    role="tab"
                    tabIndex={contentMode === mode ? 0 : -1}
                    aria-controls={contentViewId}
                    aria-selected={contentMode === mode}
                    onClick={() => setContentMode(mode)}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const nextMode =
                        event.key === "Home"
                          ? "edit"
                          : event.key === "End"
                            ? "preview"
                            : contentMode === "edit"
                              ? "preview"
                              : "edit";
                      setContentMode(nextMode);
                      document
                        .getElementById(`${contentViewId}-tab-${nextMode}`)
                        ?.focus();
                    }}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs capitalize outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                      contentMode === mode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-500 hover:text-slate-200",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <SubmitShortcut asChild>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:max-w-xl">
                <Input
                  value={aiRequest}
                  disabled={formDisabled}
                  aria-label="AI editing request"
                  placeholder={
                    body.trim() ? "Editing request" : "What should it cover?"
                  }
                  onChange={(event) => setAiRequest(event.target.value)}
                  className="h-8 min-w-28 flex-1 border-slate-800 bg-slate-950"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    setup.saving ||
                    aiCancelling ||
                    (!aiBusy &&
                      (formDisabled || !name.trim() || !setup.workspaceRoot))
                  }
                  tooltip={
                    !setup.workspaceRoot && !aiBusy
                      ? "Select a workspace to use AI editing."
                      : undefined
                  }
                  onClick={() =>
                    void (aiBusy ? cancelAiAssist() : runAiAssist())
                  }
                  {...(!aiBusy ? SUBMIT_SHORTCUT_ACTION_PROPS : {})}
                >
                  {aiBusy ? (
                    aiCancelling ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )
                  ) : body.trim() ? (
                    <WandSparkles className="size-4" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  {aiBusy
                    ? aiCancelling
                      ? "Canceling"
                      : "Cancel"
                    : body.trim()
                      ? "Improve"
                      : "Create"}
                </Button>
              </div>
            </SubmitShortcut>
          </div>
          {aiError ? (
            <p
              role="alert"
              className="border-b border-red-950 bg-red-950/20 px-4 py-2 text-sm text-red-300"
            >
              {aiError}
            </p>
          ) : null}
          <div
            id={contentViewId}
            role="tabpanel"
            aria-labelledby={`${contentViewId}-tab-${contentMode}`}
            className="min-h-[34rem]"
          >
            {contentMode === "edit" ? (
              <Textarea
                value={body}
                maxLength={MAX_INSTRUCTION_SOURCE_BYTES}
                disabled={formDisabled}
                aria-label="Instruction Markdown"
                aria-invalid={bodyInvalid}
                aria-describedby={bodyInvalid ? validationErrorId : undefined}
                onChange={(event) => setBody(event.target.value)}
                spellCheck={false}
                className="min-h-[34rem] resize-y rounded-none border-0 bg-slate-950/70 p-5 font-mono text-sm leading-6 text-slate-100 focus-visible:ring-0"
              />
            ) : body.trim() ? (
              <article className="mx-auto max-w-4xl px-6 py-7 sm:px-8">
                {runtime.renderMarkdown(body, "text-sm text-slate-200")}
              </article>
            ) : (
              <div className="grid min-h-[34rem] place-items-center text-sm text-slate-600">
                Nothing to preview
              </div>
            )}
          </div>
        </section>
      </div>
    </SubmitShortcut>
  );
}
