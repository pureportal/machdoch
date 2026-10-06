import type { ReactNode } from "react";
import type {
  InstructionMutationInput,
  InstructionMutationResult,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";

export interface InstructionManagementControls {
  workspaceRoot: string | null;
  registry: InstructionRegistryResult | null;
  loading: boolean;
  saving: boolean;
  message: { tone: "success" | "error"; text: string } | null;
  onRefresh: () => Promise<void> | void;
  onSave: (
    input: InstructionMutationInput,
  ) =>
    | Promise<InstructionMutationResult | false | void>
    | InstructionMutationResult
    | false
    | void;
}

export interface InstructionRuntime {
  runAiTask(workspace: string, prompt: string, taskId: string): Promise<string>;
  cancelAiTask(taskId: string): Promise<void>;
  renderMarkdown(content: string, className?: string): ReactNode;
}

export type FileFilter = "all" | "global" | "tag-match" | "manual" | "disabled";
export type ContentMode = "edit" | "preview";
