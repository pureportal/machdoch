import { useMemo, useRef } from "react";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import type {
  InstructionProfileView,
  InstructionTagRule,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";
import { createEmptyTagGroup } from "./tag-rule-editor";
import type {
  InstructionManagementControls,
  FileFilter,
  ContentMode,
} from "./types";

interface InstructionCommandState {
  files: InstructionProfileView[];
  filteredFiles: InstructionProfileView[];
  selectedFileId: string | null;
  selectedFile: InstructionProfileView | null;
  filter: FileFilter;
  contentMode: ContentMode;
  creating: boolean;
  dirty: boolean;
  enabled: boolean;
  global: boolean;
  match: InstructionTagRule | null;
  name: string;
  body: string;
  aiBusy: boolean;
  aiCancelling: boolean;
  formDisabled: boolean;
  hasManualAssignments: boolean;
  validationError: string | null;
  tagDraftPending: boolean;
  libraryUnavailable: boolean;
  setup: InstructionManagementControls;
  recovery: InstructionRegistryResult["recovery"];
  startFile(): void;
  selectFile(id: string): void;
  refresh(): void;
  saveFile(): Promise<void>;
  discardChanges(): void;
  duplicateFile(): Promise<void>;
  deleteFile(): Promise<void>;
  restoreRecovery(): void;
  resetRecovery(): void;
  setFilter(value: FileFilter): void;
  setContentMode(value: ContentMode): void;
  setEnabled(value: boolean): void;
  setGlobalMode(value: boolean): void;
  setMatch(value: InstructionTagRule | null): void;
  runAiAssist(): Promise<void>;
  cancelAiAssist(): Promise<void>;
}

export function useInstructionCommands(
  commandState: InstructionCommandState,
): void {
  const stateRef = useRef(commandState);
  stateRef.current = commandState;
  const instructionCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "instructions",
      viewId: "instructions",
    };
    const state = () => stateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    return asPaletteCommands([
      {
        id: "instructions.file.new",
        title: "New instruction file",
        group: "Instructions",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("instructions.file.new"),
            runtimes: ["tauri", "browser"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () =>
          state().formDisabled
            ? { state: "disabled", reason: "Instruction library is busy." }
            : { state: "enabled" },
        overlayPolicy: "replace-non-modal",
        execute: () => state().startFile(),
      },
      {
        id: "instructions.file.open",
        title: "Open instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          state().files.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No instruction files." },
        children: () => ({
          id: "instructions.file.open.page",
          title: "Open instruction file",
          searchPlaceholder: "Search instruction files",
          numericSelection: true,
          groups: [
            {
              id: "files",
              items: state().files.map((file, index) => ({
                id: file.id,
                title: file.name,
                keywords: [file.description ?? "", ...file.tags],
                current: state().selectedFileId === file.id,
                numericKey: numericKey(index),
                availability:
                  state().setup.saving || state().aiBusy
                    ? { state: "disabled", reason: "Instructions are busy." }
                    : { state: "enabled" },
                execute: () => state().selectFile(file.id),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.refresh",
        title: "Refresh instructions",
        group: "Instructions",
        scope,
        availability: () =>
          state().setup.loading || state().setup.saving || state().aiBusy
            ? { state: "disabled", reason: "Instructions are busy." }
            : { state: "enabled" },
        execute: () => state().refresh(),
      },
      {
        id: "instructions.file.save",
        title: "Save instruction file",
        group: "Instructions",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("instructions.file.save"),
            runtimes: ["tauri", "browser"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () => {
          const current = state();
          if (!current.selectedFile && !current.creating)
            return { state: "hidden" };
          if (current.formDisabled)
            return {
              state: "disabled",
              reason: "Instruction library is unavailable.",
            };
          if (current.tagDraftPending)
            return {
              state: "disabled",
              reason: "Finish editing the pending tag.",
            };
          if (current.validationError)
            return { state: "disabled", reason: current.validationError };
          if (!current.dirty)
            return { state: "disabled", reason: "No changes to save." };
          return { state: "enabled" };
        },
        execute: () => void state().saveFile(),
      },
      {
        id: "instructions.file.discard",
        title: "Discard instruction changes",
        group: "Instructions",
        scope,
        availability: () =>
          state().creating || state().dirty
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().discardChanges(),
      },
      {
        id: "instructions.file.duplicate",
        title: "Duplicate instruction file",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile) return { state: "hidden" };
          return current.formDisabled || current.dirty
            ? { state: "disabled", reason: "Save or discard changes first." }
            : { state: "enabled" };
        },
        execute: () => void state().duplicateFile(),
      },
      {
        id: "instructions.file.delete",
        title: "Delete instruction file",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile) return { state: "hidden" };
          if (current.hasManualAssignments)
            return {
              state: "disabled",
              reason: "Remove workspace assignments first.",
            };
          return current.formDisabled || current.dirty
            ? { state: "disabled", reason: "Save or discard changes first." }
            : { state: "enabled" };
        },
        execute: () => void state().deleteFile(),
      },
      {
        id: "instructions.filter.select",
        title: "Filter instruction files",
        group: "Instructions",
        scope,
        children: () => ({
          id: "instructions.filter.select.page",
          title: "Filter instruction files",
          searchPlaceholder: "Search filters",
          numericSelection: true,
          groups: [
            {
              id: "filters",
              items: (
                ["all", "global", "tag-match", "manual", "disabled"] as const
              ).map((value, index) => ({
                id: value,
                title:
                  value === "tag-match"
                    ? "Tag match"
                    : `${value[0]?.toUpperCase()}${value.slice(1)}`,
                current: state().filter === value,
                numericKey: numericKey(index),
                execute: () => state().setFilter(value),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.content.mode",
        title: "Choose content view",
        group: "Instructions",
        scope,
        availability: () =>
          state().selectedFile || state().creating
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "instructions.content.mode.page",
          title: "Choose content view",
          searchPlaceholder: "Search views",
          numericSelection: true,
          groups: [
            {
              id: "views",
              items: (["edit", "preview"] as const).map((mode, index) => ({
                id: mode,
                title: mode === "edit" ? "Edit" : "Preview",
                current: state().contentMode === mode,
                numericKey: numericKey(index),
                execute: () => state().setContentMode(mode),
              })),
            },
          ],
        }),
      },
      {
        id: "instructions.file.toggle-enabled",
        title: "Toggle instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled || state().global
              ? {
                  state: "disabled",
                  reason: "Global files are always enabled.",
                }
              : { state: "enabled" },
        current: () => state().global || state().enabled,
        execute: () => state().setEnabled(!state().enabled),
      },
      {
        id: "instructions.file.toggle-global",
        title: "Toggle global instruction file",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled || state().hasManualAssignments
              ? {
                  state: "disabled",
                  reason: "Remove workspace assignments first.",
                }
              : { state: "enabled" },
        current: () => state().global,
        execute: () => state().setGlobalMode(!state().global),
      },
      {
        id: "instructions.file.toggle-tag-match",
        title: "Toggle workspace tag match",
        group: "Instructions",
        scope,
        availability: () =>
          !state().selectedFile && !state().creating
            ? { state: "hidden" }
            : state().formDisabled ||
                state().global ||
                state().hasManualAssignments
              ? {
                  state: "disabled",
                  reason: "Assignment mode cannot be changed.",
                }
              : { state: "enabled" },
        current: () => state().match !== null,
        execute: () =>
          state().setMatch(state().match ? null : createEmptyTagGroup()),
      },
      {
        id: "instructions.ai.run",
        title: "Create or improve with AI",
        group: "Instructions",
        scope,
        availability: () => {
          const current = state();
          if (!current.selectedFile && !current.creating)
            return { state: "hidden" };
          if (!current.setup.workspaceRoot)
            return { state: "disabled", reason: "Select a workspace first." };
          if (!current.name.trim())
            return { state: "disabled", reason: "Enter a file name first." };
          if (current.formDisabled)
            return {
              state: "disabled",
              reason: "Instruction file is unavailable.",
            };
          return current.aiBusy || current.aiCancelling
            ? { state: "disabled", reason: "AI editing is already running." }
            : { state: "enabled" };
        },
        execute: () => void state().runAiAssist(),
      },
      {
        id: "instructions.ai.cancel",
        title: "Cancel AI editing",
        group: "Instructions",
        scope,
        availability: () =>
          state().aiBusy
            ? state().aiCancelling
              ? { state: "disabled", reason: "Cancellation is in progress." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => void state().cancelAiAssist(),
      },
      {
        id: "instructions.recovery.restore",
        title: "Restore instruction library backup",
        group: "Instructions",
        scope,
        availability: () =>
          state().recovery?.backupValid && state().recovery?.backupDigest
            ? state().setup.saving || state().aiBusy
              ? { state: "disabled", reason: "Instructions are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().restoreRecovery(),
      },
      {
        id: "instructions.recovery.reset",
        title: "Reset instruction library",
        group: "Instructions",
        scope,
        availability: () =>
          state().recovery?.resetDigest
            ? state().setup.saving || state().aiBusy
              ? { state: "disabled", reason: "Instructions are busy." }
              : { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().resetRecovery(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(instructionCommands);
}
