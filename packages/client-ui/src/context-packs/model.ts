import type {
  RuntimeProvider,
  RunMode,
  ReasoningMode,
  PromptEnhancementMode,
} from "@machdoch/fleet-protocol/runtime-options";
import type { ChatSessionContextAttachment } from "../composer/model";

export interface SmartContextPackVariable {
  name: string;
  defaultValue?: string;
}

export interface SmartContextPackTrigger {
  phrases: string[];
  pathPatterns: string[];
}

export interface SmartContextPackSettingOverrides {
  provider?: RuntimeProvider;
  model?: string;
  mode?: RunMode;
  reasoning?: ReasoningMode;
  promptEnhancementMode?: PromptEnhancementMode;
  interviewEnabled?: boolean;
  sessionMemoryEnabled?: boolean;
  useWorkspaceMemory?: boolean;
  useGlobalMemory?: boolean;
  uiControlEnabled?: boolean;
}

export interface SmartContextPack extends SmartContextPackSettingOverrides {
  id: string;
  workspace: string | null;
  name: string;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: SmartContextPackVariable[];
  trigger: SmartContextPackTrigger;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
}

export interface SaveSmartContextPackInput extends SmartContextPackSettingOverrides {
  id?: string;
  name: string;
  scope: SmartContextPackScope;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: Array<string | SmartContextPackVariable>;
  triggerPhrases: string[];
  triggerPathPatterns: string[];
}

export type SmartContextPackScope = "workspace" | "global";

export type SmartContextPackScopeFilter = SmartContextPackScope | "all";

export interface SmartContextPackExportPayload {
  kind: "machdoch.context-packs";
  version: 1;
  exportedAt: number;
  contextPacks: SmartContextPack[];
}
