import { createTestCloudDatabase } from "../server/cloud/test-database";
import { initializeInstallation } from "../server/cloud/installation-storage";
import { cloudCredentialsCipher } from "../server/cloud/credential-storage";
import {
  createCloudRuntime,
  getCloudRuntime,
  setCloudRuntimeForTests,
} from "../server/cloud/runtime";
import { runtimeConfig } from "../server/config";
import { FleetDatabase } from "../server/database";
import { FleetStore } from "../server/fleet-store";
import { SettingsStore } from "../server/settings-store";
import { verifySettingsCipher } from "../server/settings-crypto";
import { GatewayHub } from "../server/gateway";
import type { FleetRuntime } from "../server/runtime";

export async function createRemoteTestDatabase(): Promise<FleetDatabase> {
  const cloud = await createTestCloudDatabase();
  const database = new FleetDatabase(cloud);
  await database.initialize();
  return database;
}

export async function createRemoteTestRuntime(): Promise<FleetRuntime> {
  const cloudDatabase = await createTestCloudDatabase();
  const database = new FleetDatabase(cloudDatabase);
  await database.initialize();
  const installation = await initializeInstallation(cloudDatabase);
  const cipher = cloudCredentialsCipher(installation.credentials_key)!;
  const origin = "https://fleet.example.test";
  const cloud = createCloudRuntime(cloudDatabase, origin, {
    credentialsCipher: cipher,
  });
  const actor = await cloud.identity.bootstrap({
    organization: "Test",
    name: "owner",
    email: "owner@example.test",
    password: "a secure test password",
    origin,
  });
  await cloudDatabase.transaction(async (sql) => {
    await sql.query(
      "UPDATE cloud_users SET email=NULL,login_name='owner' WHERE id=$1",
      [actor.userId],
    );
  });
  setCloudRuntimeForTests(cloud);
  const config = runtimeConfig(origin);
  const fleetStore = new FleetStore(database);
  await verifySettingsCipher(database, cipher);
  return {
    config,
    database,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher: cipher,
    gateways: new GatewayHub(config, fleetStore),
  };
}

export async function revokeRemoteTestSessions(): Promise<void> {
  const cloud = await getCloudRuntime();
  await cloud.database.transaction(async (sql) => {
    await sql.query("DELETE FROM cloud_sessions");
  });
}
