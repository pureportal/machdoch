export interface ManagedDefaults {
  provider: string | null;
  model: string | null;
  mode: string | null;
  reasoning: string | null;
  webSearchProvider: string | null;
  theme: string | null;
  density: string | null;
  accent: string | null;
}

export interface ManagedAgentLimits {
  infinite: boolean | null;
  executorTurns: number | null;
  autopilotExecutorIterations: number | null;
}

export interface ManagedInstruction {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
  global: boolean;
  tags: string[];
}

export interface ManagedContextPack {
  id: string;
  name: string;
  instructions: string;
  prompt: string;
  provider: string | null;
  model: string | null;
  mode: string | null;
  reasoning: string | null;
  variables: Array<{
    name: string;
    defaultValue: string | null;
  }>;
  triggerPhrases: string[];
  pathPatterns: string[];
  promptEnhancementMode: "off" | "simple" | "web-search" | null;
  interviewEnabled: boolean | null;
  sessionMemoryEnabled: boolean | null;
  useGlobalMemory: boolean | null;
  uiControlEnabled: boolean | null;
}

export interface ManagedPrompt {
  id: string;
  relativePath: string;
  content: string;
}

export interface ManagedSettingsDocument {
  defaults: ManagedDefaults;
  agentLimits: ManagedAgentLimits;
  instructions: ManagedInstruction[];
  contextPacks: ManagedContextPack[];
  prompts: ManagedPrompt[];
}

export interface SettingsSecretSummary {
  secretId: string;
  lastFour: string;
  updatedAt: number;
}

export interface SettingsProfile {
  profileId: string;
  name: string;
  description: string;
  revision: number;
  document: ManagedSettingsDocument;
  secrets: SettingsSecretSummary[];
  createdAt: number;
  updatedAt: number;
}

export interface SettingsProfileSummary {
  profileId: string;
  name: string;
  description: string;
  revision: number;
  instructionCount: number;
  contextPackCount: number;
  promptCount: number;
  secretCount: number;
  assignmentCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecretDescriptor {
  id: string;
  label: string;
  category: string;
}

export interface SettingsCatalog {
  secrets: SecretDescriptor[];
  limits: {
    maximumProfiles: number;
    maximumInstructionsPerProfile: number;
    maximumPacksPerProfile: number;
    maximumPromptsPerProfile: number;
    maximumDocumentBytes: number;
    maximumSecretBytes: number;
  };
}

export interface SettingsAssignment {
  instanceId: string;
  displayName: string;
  instanceStatus: "online" | "offline" | "revoked";
  profileId: string | null;
  profileName: string | null;
  profileRevision: number | null;
  assignedAt: number | null;
  lastAppliedRevision: number | null;
  lastAppliedAt: number | null;
  syncStatus: "unassigned" | "pending" | "applied" | "failed";
  lastSyncRevision: number | null;
  lastSyncAttemptAt: number | null;
  syncError: string | null;
}

export interface SettingsProfileVersion {
  revision: number;
  name: string;
  description: string;
  changeSummary: string;
  createdAt: number;
}

export type SettingsTab =
  | "general"
  | "instructions"
  | "packs"
  | "prompts"
  | "secrets"
  | "instances"
  | "history";

export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function optionalValue(value: string): string | null {
  return value.trim() || null;
}
