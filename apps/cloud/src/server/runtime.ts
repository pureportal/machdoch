import { runtimeConfig, type CloudServerConfig } from "./config";
import { FleetDatabase } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";
import { type SettingsCipher, verifySettingsCipher } from "./settings-crypto";
import { SettingsStore } from "./settings-store";
import type { FleetPreviewHub } from "./previews";
import { getCloudRuntime } from "./cloud/runtime";
import { initializeInstallation } from "./cloud/installation-storage";
import { cloudCredentialsCipher } from "./cloud/credential-storage";

export interface FleetRuntime {
  previews?: FleetPreviewHub;
  config: CloudServerConfig;
  database: FleetDatabase;
  fleetStore: FleetStore;
  settingsStore: SettingsStore;
  settingsCipher: SettingsCipher | null;
  gateways: GatewayHub;
}

const runtimeSymbol = Symbol.for("machdoch.remote.runtime");

interface GlobalRuntime {
  [runtimeSymbol]?: FleetRuntime;
}

export function getRuntime(): FleetRuntime {
  const globalRuntime = globalThis as GlobalRuntime;
  if (globalRuntime[runtimeSymbol]) return globalRuntime[runtimeSymbol];
  throw new Error("Cloud runtime has not been initialized.");
}

export async function initializeRuntime(): Promise<FleetRuntime> {
  const globalRuntime = globalThis as GlobalRuntime;
  if (globalRuntime[runtimeSymbol]) return globalRuntime[runtimeSymbol];
  const cloud = await getCloudRuntime();
  const installation = await initializeInstallation(cloud.database);
  const config = runtimeConfig(
    installation.origin ?? "",
    installation.remote_config,
  );
  const database = new FleetDatabase(cloud.database);
  const fleetStore = new FleetStore(database);
  const settingsCipher = cloudCredentialsCipher(installation.credentials_key);
  if (settingsCipher) await verifySettingsCipher(database, settingsCipher);
  const runtime: FleetRuntime = {
    config,
    database,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher,
    gateways: new GatewayHub(config, fleetStore),
  };
  globalRuntime[runtimeSymbol] = runtime;
  return runtime;
}

export function closeRuntime(): void {
  const globalRuntime = globalThis as GlobalRuntime;
  const runtime = globalRuntime[runtimeSymbol];
  if (!runtime) return;
  runtime.gateways.close();
  runtime.previews?.close();
  delete globalRuntime[runtimeSymbol];
}

export function setRuntimeForTests(runtime: FleetRuntime | undefined): void {
  const globalRuntime = globalThis as GlobalRuntime;
  if (runtime) globalRuntime[runtimeSymbol] = runtime;
  else delete globalRuntime[runtimeSymbol];
}
