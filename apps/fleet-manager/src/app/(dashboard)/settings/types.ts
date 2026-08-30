export interface ManagedDefaults {
  preferredToolingAgent: string | null;
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
  variables: string[];
  triggerPhrases: string[];
  pathPatterns: string[];
}

export interface ManagedSettingsDocument {
  defaults: ManagedDefaults;
  agentLimits: ManagedAgentLimits;
  instructions: ManagedInstruction[];
  contextPacks: ManagedContextPack[];
  customValues: Record<string, unknown>;
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
  lastFetchedRevision: number | null;
  lastFetchedAt: number | null;
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
