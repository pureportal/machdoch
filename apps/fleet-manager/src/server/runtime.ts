import { resolve } from "node:path";
import { AuthStore } from "./auth-store";
import {
  loadConfig,
  type FleetManagerConfig,
  type FleetManagerRuntimeMode,
} from "./config";
import { FleetDatabase } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";
import { LoginThrottle } from "./login-throttle";
import {
  loadSettingsCipher,
  type SettingsCipher,
  verifySettingsCipher,
} from "./settings-crypto";
import { SettingsStore } from "./settings-store";

export interface FleetRuntime {
  config: FleetManagerConfig;
  database: FleetDatabase;
  authStore: AuthStore;
  fleetStore: FleetStore;
  settingsStore: SettingsStore;
  settingsCipher: SettingsCipher | null;
  gateways: GatewayHub;
  loginThrottle: LoginThrottle;
}

const runtimeSymbol = Symbol.for("machdoch.fleet-manager.runtime");

interface GlobalRuntime {
  [runtimeSymbol]?: FleetRuntime;
}

export function getRuntime(
  runtimeMode: FleetManagerRuntimeMode = "production",
): FleetRuntime {
  const globalRuntime = globalThis as GlobalRuntime;
  if (globalRuntime[runtimeSymbol]) return globalRuntime[runtimeSymbol];
  const configPath =
    process.env.MACHDOCH_FLEET_MANAGER_CONFIG ??
    resolve(process.cwd(), "fleet-manager.json");
  const config = loadConfig(configPath, runtimeMode);
  const database = new FleetDatabase(config.database.path);
  const authStore = new AuthStore(database);
  const fleetStore = new FleetStore(database);
  const settingsCipher = loadSettingsCipher(config);
  if (settingsCipher) verifySettingsCipher(database, settingsCipher);
  const runtime: FleetRuntime = {
    config,
    database,
    authStore,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher,
    gateways: new GatewayHub(config, fleetStore),
    loginThrottle: new LoginThrottle(),
  };
  globalRuntime[runtimeSymbol] = runtime;
  return runtime;
}

export function closeRuntime(): void {
  const globalRuntime = globalThis as GlobalRuntime;
  const runtime = globalRuntime[runtimeSymbol];
  if (!runtime) return;
  runtime.gateways.close();
  runtime.database.close();
  delete globalRuntime[runtimeSymbol];
}

export function setRuntimeForTests(runtime: FleetRuntime | undefined): void {
  const globalRuntime = globalThis as GlobalRuntime;
  if (runtime) globalRuntime[runtimeSymbol] = runtime;
  else delete globalRuntime[runtimeSymbol];
}
