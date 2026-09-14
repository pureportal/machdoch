import { useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { CommandProvider } from "../commands/command-context";
import { TooltipProvider } from "../components/ui/tooltip";
import { RalphFlowEditor } from "../ralph/ralph-flow-editor";
import { ChatInputNeededDialog } from "../chat-session/components/chat-input-needed-dialog";
import { ChatInterviewDialog } from "../chat-session/components/chat-interview-dialog";
import type { ChatInterviewDialogState } from "../chat-session/_helpers/chat-interview";
import { AttachmentImagePreviewDialog } from "../chat-session/components/attachment-image-preview-dialog";
import { FilePreviewDialog } from "../chat-session/components/file-preview-dialog";
import { createSession } from "../chat-session.model";
import { VoiceInputOverlay } from "../components/voice-input-overlay";
import { MediaAssetImportDialog } from "../media/components/media-asset-import-dialog";
import { MediaCategoryManagerDialog } from "../media/components/media-category-manager-dialog";
import { RalphExpandedEditorDialog } from "../ralph/components/ralph-editor-dialogs";
import { RalphOverview } from "../ralph/components/ralph-overview";
import { OnboardingWizard } from "../chat-session/components/onboarding-wizard";
import { useChatSessionController } from "../chat-session/_helpers/use-chat-session-controller";
import { useAppearanceSettings } from "../chat-session/_helpers/use-appearance-settings";
import { RalphGenerationInterviewDialog } from "../ralph/components/ralph-generation-interview-dialog";
import { WorkspaceRunDialogControl } from "../chat-session/components/workspace-run-dialog-control";
import { MediaImageMaskEditor } from "../media/components/media-image-mask-editor";
import { TaskTimeoutControls } from "../task-timeout-controls";
import type { MediaImageMask } from "../../../core/media/contracts";
import {
  createOverviewLibrary,
  createOverviewRun,
  createOverviewTask,
} from "../ralph/__test__/ralph-overview-fixtures";

const imageSource =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#163445"/></svg>',
  );
const longName = "LongFileNameForResponsiveLayoutVerification".repeat(5);
const root = createRoot(document.getElementById("root")!);

function ImageMask(): JSX.Element {
  const [mask, setMask] = useState<MediaImageMask | null>(null);
  return (
    <div className="h-full overflow-y-auto p-4">
      <MediaImageMaskEditor
        asset={{
          id: "asset:responsive",
          runId: "run:responsive",
          digest: "e".repeat(64),
          kind: "image",
          mimeType: "image/png",
          byteSize: 2048,
          width: 1600,
          height: 800,
          createdAt: "2026-09-13T20:00:00.000Z",
          outputIndex: 0,
          fixture: true,
          operation: null,
          sourceAssetIds: [],
          tags: [],
        }}
        value={mask}
        onChange={setMask}
      />
    </div>
  );
}

function Onboarding(): JSX.Element {
  const appearance = useAppearanceSettings();
  const controller = useChatSessionController({
    enableBackgroundMaintenance: false,
    enableTaskProgress: false,
  });
  return (
    <OnboardingWizard
      {...controller.settingsDialog}
      appearanceSetup={appearance}
      activeSession={controller.composer.activeSession}
      chooserProviders={controller.composer.chooserProviders}
      hasAnyProvider={controller.hasAnyProvider}
      isUiControlAvailable={controller.composer.isUiControlAvailable}
      uiControlDescription={controller.composer.uiControlDescription}
      onSelectFolder={controller.composer.onSelectFolder}
      onSessionModelSelection={controller.composer.onSessionModelSelection}
      onSessionModeSelection={controller.composer.onSessionModeSelection}
      onUiControlEnabledChange={controller.composer.onUiControlEnabledChange}
      onFinish={() => {}}
      onSkip={() => {}}
    />
  );
}

function ExpandedEditor(): JSX.Element {
  const [draft, setDraft] = useState(longName);
  const [wrap, setWrap] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <RalphExpandedEditorDialog
      editor={{
        title: "Prompt",
        description: "Edit the prompt.",
        ariaLabel: "Expanded prompt",
        mode: "text",
        value: draft,
        supportsVariables: true,
        onApply: setDraft,
      }}
      draft={draft}
      wrap={wrap}
      variableSnippets={["{{input.task}}", "{{workspaceRoot}}"]}
      textareaRef={textareaRef}
      onDraftChange={setDraft}
      onWrapChange={setWrap}
      onClose={() => {}}
      onApply={() => {}}
      onCopy={() => {}}
      onInsertSnippet={(snippet) => setDraft((value) => value + snippet)}
    />
  );
}

function Interview(): JSX.Element {
  const [state, setState] = useState<ChatInterviewDialogState>({
    context: {
      sessionSnapshot: createSession(),
      task: "Review the workspace",
      contextAttachments: [],
      mode: "machdoch",
      provider: "openai",
      model: "gpt-5.6-sol",
    },
    status: "ready",
    fields: [
      {
        id: "description",
        label: "Describe the change",
        type: "textarea",
        required: true,
      },
      {
        id: "target",
        label: "Target",
        type: "select",
        options: [
          { label: "Mobile and tablet layouts", value: "mobile" },
          { label: "Desktop", value: "desktop" },
        ],
      },
    ],
    values: {},
    answerComments: {},
    expandedCommentFieldIds: [],
    skippedFieldIds: [],
    validationErrors: {},
    summary: "Review the requested change.",
    findings: [],
    assumptions: [],
    relevantFiles: [],
  });
  return (
    <ChatInterviewDialog
      state={state}
      onClose={() => {}}
      onValueChange={(id, value) =>
        setState((current) => ({
          ...current,
          values: { ...current.values, [id]: value },
        }))
      }
      onToggleComment={(id) =>
        setState((current) => ({
          ...current,
          expandedCommentFieldIds: [...current.expandedCommentFieldIds, id],
        }))
      }
      onCommentChange={(id, value) =>
        setState((current) => ({
          ...current,
          answerComments: { ...current.answerComments, [id]: value },
        }))
      }
      onSkipField={() => {}}
      onStartNow={() => {}}
      onSubmitAnswers={() => {}}
    />
  );
}

function Surface({ name }: { name: string }): JSX.Element {
  if (name === "image-mask") return <ImageMask />;
  if (name === "workspace-run")
    return (
      <WorkspaceRunDialogControl
        workspaceRoot="C:/responsive-fixture"
        primaryTaskRunning={false}
      />
    );
  if (name === "onboarding") return <Onboarding />;
  if (name === "ralph-interview")
    return (
      <RalphGenerationInterviewDialog
        state={{
          context: {
            workspaceRoot: "C:/responsive-fixture",
            userPrompt: "Review the workspace",
            generationPrompt: "Review the workspace",
            target: "flow",
            generationMode: "interview",
            targetScope: "workspace",
            targetFlowName: "Review",
            targetFlowId: null,
            selectedIdAtStart: null,
            selectedScopeAtStart: "workspace",
            draftSnapshotAtStart: "",
          },
          status: "ready",
          fields: [
            { id: "goal", label: "Goal", type: "textarea", required: true },
          ],
          values: {},
          answerComments: {},
          expandedCommentFieldIds: [],
          skippedFieldIds: [],
          validationErrors: {},
          summary: "Review the requested change.",
          findings: [],
          assumptions: [],
          relevantFiles: [],
        }}
        renderInputControl={(field) => (
          <textarea aria-label={field.label} className="w-full min-w-0" />
        )}
        getDefaultInputValue={() => ""}
        onClose={() => {}}
        onValueChange={() => {}}
        onToggleComment={() => {}}
        onCommentChange={() => {}}
        onSkipField={() => {}}
        onGenerateNow={() => {}}
        onSubmitAnswers={() => {}}
      />
    );
  if (name === "ralph-expanded-editor") return <ExpandedEditor />;
  if (name === "task-timeout")
    return (
      <TaskTimeoutControls taskId="responsive-task" idleTimeoutMs={60000} />
    );
  if (name === "ralph-overview")
    return (
      <RalphOverview
        libraries={[
          {
            ...createOverviewLibrary("C:/responsive-fixture"),
            runs: [createOverviewRun()],
          },
        ]}
        tasks={[createOverviewTask("C:/responsive-fixture", "responsive-task")]}
        taskError={null}
        tasksLoaded
        workspaceRoot="C:/responsive-fixture"
        onOpen={() => {}}
        onRefresh={() => {}}
        onChooseWorkspace={() => {}}
      />
    );
  if (name === "media-import")
    return (
      <MediaAssetImportDialog
        assets={[]}
        categories={[]}
        loading={false}
        progress={null}
        modelInspection={null}
        addonInspection={null}
        civitaiInspection={null}
        error={null}
        onInspectModel={() => {}}
        onInspectAddon={() => {}}
        onInspectCivitai={() => {}}
        onImportMedia={async () => null}
        onImportModel={async () => false}
        onImportAddon={async () => false}
        onImportSampleUrl={async () => null}
        onViewResource={() => {}}
        onDismissInspection={() => {}}
        onManageCategories={() => {}}
        onClose={() => {}}
      />
    );
  if (name === "media-categories")
    return (
      <MediaCategoryManagerDialog
        categories={[{ id: "long", name: longName }]}
        metadata={{}}
        onChange={() => {}}
        onClose={() => {}}
      />
    );
  if (name === "ralph")
    return (
      <RalphFlowEditor
        workspaceRoot="C:/responsive-fixture"
        runMode="machdoch"
        generationProvider="openai"
        generationModel="gpt-5.6-sol"
        runProvider="openai"
        runModel="gpt-5.6-sol"
      />
    );
  if (name === "interview") return <Interview />;
  if (name === "input" || name === "input-options")
    return (
      <ChatInputNeededDialog
        request={{
          currentIndex: 0,
          totalCount: 2,
          placeholder: {
            key: longName,
            lookupKey: longName,
            occurrenceCount: 1,
            ...(name === "input-options"
              ? { options: [longName, "Short option"] }
              : {}),
          },
        }}
        onCancel={() => {}}
        onSubmitValue={() => {}}
      />
    );
  if (name === "image" || name === "image-error")
    return (
      <AttachmentImagePreviewDialog
        preview={{
          attachment: {
            id: "image",
            source: "path",
            path: `C:/review/${longName}.png`,
            name: `${longName}.png`,
            kind: "image",
          },
          source: name === "image" ? imageSource : null,
          loading: false,
          error:
            name === "image-error"
              ? "Image could not be loaded. Choose another image."
              : null,
        }}
        onOpenChange={() => {}}
        onSaveToMediaLibrary={() => {}}
      />
    );
  if (name === "file" || name === "file-error")
    return (
      <FilePreviewDialog
        preview={{
          title: `${longName}.md`,
          path: `C:/review/${longName}.md`,
          mode: "text",
          loading: false,
          error: name === "file-error" ? "File could not be read." : null,
          source: null,
          content:
            `# Workspace\n\n${longName}\n\n` +
            Array.from(
              { length: 40 },
              (_, index) => `Line ${index + 1}: review the workspace`,
            ).join("\n"),
          language: null,
          languageLabel: "Markdown",
          truncated: false,
          lossy: false,
          targetLine: null,
        }}
        onOpenChange={() => {}}
        onOpenExternal={() => {}}
      />
    );
  return (
    <VoiceInputOverlay
      title="Voice input"
      recording={name === "voice-recording"}
      transcribing={name === "voice-transcribing"}
      level={0.4}
      statusText={
        name === "voice-error"
          ? "Microphone unavailable. Check microphone access."
          : null
      }
      onPrimaryAction={() => {}}
    />
  );
}

export function mountResponsiveSurface(name: string): void {
  root.render(
    <CommandProvider activeView="ralph" platform="windows" runtime="browser">
      <TooltipProvider>
        <div className="app-shell h-dvh min-w-0 overflow-hidden bg-slate-950 text-slate-100">
          <Surface key={name} name={name} />
        </div>
      </TooltipProvider>
    </CommandProvider>,
  );
}
