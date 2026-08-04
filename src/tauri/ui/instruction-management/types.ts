import type {
  InstructionMutationInput,
  InstructionMutationResult,
  InstructionRegistryResult,
} from "../runtime";

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
