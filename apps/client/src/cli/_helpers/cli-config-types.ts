import type { ConfigSnapshot } from "./cli-config-snapshot.js";

export type CliConfigScope = "user" | "workspace";

export interface CliConfigSettingDefinition {
  setting: string;
  label?: string;
  category: string;
  scope: CliConfigScope;
  description: string;
  acceptedValues: string;
  choices?: readonly string[];
  secret?: boolean;
  multiline?: boolean;
  document?: boolean;
}

export interface CliConfigEntry extends CliConfigSettingDefinition {
  value: string | number | boolean;
  source: string;
  unavailable?: string;
}

export interface ConfigSetResult {
  setting: string;
  scope: CliConfigScope;
  configPath: string;
  status: string;
  value?: string | number | boolean;
}

export interface CliConfigFamily {
  definitions: readonly CliConfigSettingDefinition[];
  save(
    workspaceRoot: string,
    setting: string,
    value: string,
  ): Promise<ConfigSetResult>;
  reset(workspaceRoot: string, setting: string): Promise<ConfigSetResult>;
  resolve?(
    definition: CliConfigSettingDefinition,
    snapshot: ConfigSnapshot,
  ): CliConfigEntry;
}
