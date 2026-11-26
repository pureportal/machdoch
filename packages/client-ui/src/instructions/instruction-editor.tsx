import {
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Save,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import type { ComponentProps, JSX } from "react";
import { MAX_INSTRUCTION_SOURCE_BYTES } from "@machdoch/fleet-protocol/instruction-limits";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../common/dropdown-menu";
import { InstructionSwitch, SegmentedControl } from "./instruction-controls";
import { InstructionDetailsPanel } from "./instruction-details-panel";
import { ACTIVATION_ICONS } from "./instruction-file-list";
import { instructionBodyByteLength } from "./instruction-form";
import type { InstructionActivation } from "./instruction-library-model";
import type { ContentMode, InstructionRuntime } from "./types";

const CONTENT_MODE_OPTIONS = [
  { value: "edit", label: "Edit" },
  { value: "split", label: "Split" },
  { value: "preview", label: "Preview" },
] as const;

const SIZE_WARNING_RATIO = 0.75;

const formatKilobytes = (bytes: number): string =>
  `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;

export interface InstructionEditorProps {
  title: string;
  creating: boolean;
  activation: InstructionActivation;
  enabled: boolean;
  dirty: boolean;
  canSave: boolean;
  formDisabled: boolean;
  canManageFile: boolean;
  deleteBlocked: boolean;
  validationError: string | null;
  validationErrorId: string;
  pendingTagMessageId: string;
  tagDraftPending: boolean;
  bodyInvalid: boolean;
  body: string;
  contentMode: ContentMode;
  aiRequest: string;
  aiBusy: boolean;
  aiCancelling: boolean;
  aiError: string | null;
  aiUnavailableReason: string | null;
  runtime: InstructionRuntime;
  details: ComponentProps<typeof InstructionDetailsPanel>;
  onEnabledChange: (enabled: boolean) => void;
  onSave: () => void;
  onDiscard: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onBodyChange: (body: string) => void;
  onContentModeChange: (mode: ContentMode) => void;
  onAiRequestChange: (request: string) => void;
  onAiRun: () => void;
  onAiCancel: () => void;
}

export function InstructionEditor({
  title,
  creating,
  activation,
  enabled,
  dirty,
  canSave,
  formDisabled,
  canManageFile,
  deleteBlocked,
  validationError,
  validationErrorId,
  pendingTagMessageId,
  tagDraftPending,
  bodyInvalid,
  body,
  contentMode,
  aiRequest,
  aiBusy,
  aiCancelling,
  aiError,
  aiUnavailableReason,
  runtime,
  details,
  onEnabledChange,
  onSave,
  onDiscard,
  onDuplicate,
  onDelete,
  onBodyChange,
  onContentModeChange,
  onAiRequestChange,
  onAiRun,
  onAiCancel,
}: InstructionEditorProps): JSX.Element {
  const Icon = ACTIVATION_ICONS[activation];
  const global = activation === "global";
  const bodyBytes = instructionBodyByteLength(body);
  const showSize =
    bodyBytes >= MAX_INSTRUCTION_SOURCE_BYTES * SIZE_WARNING_RATIO;
  const hasBody = body.trim().length > 0;

  const editor = (
    <Textarea
      value={body}
      maxLength={MAX_INSTRUCTION_SOURCE_BYTES}
      disabled={formDisabled}
      aria-label="Instruction Markdown"
      aria-invalid={bodyInvalid}
      aria-describedby={bodyInvalid ? validationErrorId : undefined}
      onChange={(event) => onBodyChange(event.target.value)}
      spellCheck={false}
      className="h-full min-h-[24rem] resize-none rounded-none border-0 bg-slate-950/70 p-5 font-mono text-sm leading-6 text-slate-100 focus-visible:ring-0"
    />
  );
  const preview = hasBody ? (
    <article className="h-full min-h-[24rem] overflow-y-auto px-6 py-5">
      {runtime.renderMarkdown(body, "text-sm text-slate-200")}
    </article>
  ) : (
    <div className="grid h-full min-h-[24rem] place-items-center text-sm text-slate-600">
      Nothing to preview
    </div>
  );

  return (
    <SubmitShortcut asChild>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-900 px-5 py-3">
          <div className="flex min-w-48 flex-1 items-center gap-2.5">
            <Icon
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0",
                activation === "manual" ? "text-slate-400" : "text-sky-300",
              )}
            />
            <h2 className="truncate text-base font-semibold text-slate-100">
              {title}
            </h2>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-slate-400">
            Enabled
            <InstructionSwitch
              label="Enabled"
              checked={global || enabled}
              disabled={formDisabled || global}
              tooltip={global ? "Global files are always on." : undefined}
              onCheckedChange={onEnabledChange}
            />
          </div>
          <div className="flex items-center gap-1.5">
            {creating || dirty ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={formDisabled}
                onClick={onDiscard}
              >
                {creating ? "Cancel" : "Discard"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              aria-describedby={
                tagDraftPending ? pendingTagMessageId : undefined
              }
              onClick={onSave}
              {...SUBMIT_SHORTCUT_ACTION_PROPS}
            >
              <Save className="size-4" />
              Save
            </Button>
            {canManageFile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`More actions for ${title}`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    disabled={formDisabled || dirty}
                    onSelect={onDuplicate}
                  >
                    <Copy className="size-4" />
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={formDisabled || dirty || deleteBlocked}
                    onSelect={onDelete}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </header>

        {dirty && validationError ? (
          <p
            id={validationErrorId}
            role="alert"
            className="shrink-0 border-b border-red-950 bg-red-950/20 px-5 py-2 text-sm text-red-300"
          >
            {validationError}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_20rem] xl:overflow-hidden">
          <section
            aria-label="Content"
            className="flex min-h-[32rem] min-w-0 flex-col xl:min-h-0"
          >
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-900 px-4 py-2">
              <SegmentedControl
                label="Instruction content view"
                value={contentMode}
                options={CONTENT_MODE_OPTIONS}
                onChange={onContentModeChange}
              />
              <SubmitShortcut asChild>
                <div className="ml-auto flex min-w-60 flex-1 items-center justify-end gap-2 sm:max-w-lg">
                  <Input
                    value={aiRequest}
                    disabled={formDisabled}
                    aria-label="AI editing request"
                    placeholder={
                      hasBody ? "Describe a change" : "What should it cover?"
                    }
                    onChange={(event) => onAiRequestChange(event.target.value)}
                    className="h-8 min-w-0 flex-1 border-slate-800 bg-slate-950"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      aiCancelling ||
                      (!aiBusy &&
                        (formDisabled || aiUnavailableReason !== null))
                    }
                    tooltip={
                      aiBusy ? undefined : (aiUnavailableReason ?? undefined)
                    }
                    onClick={aiBusy ? onAiCancel : onAiRun}
                    {...(!aiBusy ? SUBMIT_SHORTCUT_ACTION_PROPS : {})}
                  >
                    {aiBusy ? (
                      aiCancelling ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <X className="size-4" />
                      )
                    ) : hasBody ? (
                      <WandSparkles className="size-4" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {aiBusy
                      ? aiCancelling
                        ? "Canceling"
                        : "Cancel"
                      : hasBody
                        ? "Improve"
                        : "Write"}
                  </Button>
                </div>
              </SubmitShortcut>
            </div>
            {aiError ? (
              <p
                role="alert"
                className="shrink-0 border-b border-red-950 bg-red-950/20 px-4 py-2 text-sm text-red-300"
              >
                {aiError}
              </p>
            ) : null}
            <div
              className={cn(
                "grid min-h-0 flex-1",
                contentMode === "split" &&
                  "md:grid-cols-2 md:divide-x md:divide-slate-900",
              )}
            >
              {contentMode !== "preview" ? editor : null}
              {contentMode !== "edit" ? preview : null}
            </div>
            {showSize ? (
              <p
                className={cn(
                  "shrink-0 border-t border-slate-900 px-4 py-1.5 text-right text-xs tabular-nums",
                  bodyBytes > MAX_INSTRUCTION_SOURCE_BYTES
                    ? "text-red-300"
                    : "text-amber-300",
                )}
              >
                {formatKilobytes(bodyBytes)} /{" "}
                {formatKilobytes(MAX_INSTRUCTION_SOURCE_BYTES)}
              </p>
            ) : null}
          </section>
          <aside
            aria-label="File settings"
            className="order-first min-w-0 border-b border-slate-900 bg-slate-950/40 xl:order-none xl:overflow-y-auto xl:border-b-0 xl:border-l"
          >
            <InstructionDetailsPanel {...details} />
          </aside>
        </div>
      </div>
    </SubmitShortcut>
  );
}
