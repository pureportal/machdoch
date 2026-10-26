import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { CloudError } from "./access";
import { PostgresCloudDatabase } from "./database";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { initializeInstallation } from "./installation-storage";
import { findLegacyConfiguration, openLegacySource } from "./legacy-source";
import { importLegacySource } from "./legacy-import";
import { resumeImportCleanup } from "./legacy-cleanup";
import { cloudCredentialsCipher } from "./credential-storage";
import { FleetDatabase } from "../database";
import { loadWorkspaceEnvironment } from "../config";

export async function createPersistentCloudRuntime(): Promise<CloudRuntime> {
  loadWorkspaceEnvironment(process.cwd());
  const configuration = findLegacyConfiguration(
    process.env.MACHDOCH_CLOUD_IMPORT_CONFIG,
  );
  if (configuration) loadWorkspaceEnvironment(dirname(configuration));
  const connection = process.env.MACHDOCH_CLOUD_DATABASE_URL;
  if (!connection)
    throw new CloudError(
      503,
      "cloud_unconfigured",
      "Set MACHDOCH_CLOUD_DATABASE_URL to the PostgreSQL connection URL.",
    );
  const database = new PostgresCloudDatabase(connection);
  try {
    await database.migrate();
    const remote = new FleetDatabase(database);
    await remote.initialize();
    let installation = await initializeInstallation(database);
    const importedConfigurations = await resumeImportCleanup(database);
    if (
      configuration &&
      !existsSync(configuration) &&
      !importedConfigurations.has(configuration)
    )
      throw new Error("The configured migration source does not exist.");
    if (configuration && !importedConfigurations.has(configuration)) {
      const source = openLegacySource(
        configuration,
        process.env.NODE_ENV === "production" ? "production" : "development",
      );
      if (source) {
        const imported = await importLegacySource(
          database,
          source,
          installation,
        );
        console.info("Cloud migration completed", {
          counts: imported.counts,
          cleaned: imported.cleaned,
        });
        installation = await initializeInstallation(database);
      } else if (!importedConfigurations.has(configuration))
        throw new Error(
          "The configured SQLite database is missing and has no completed import. Restore the source before retrying.",
        );
    }
    const runtime = createCloudRuntime(database, installation.origin ?? "", {
      credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
    });
    return runtime;
  } catch (error) {
    await database.close();
    throw error;
  }
}
