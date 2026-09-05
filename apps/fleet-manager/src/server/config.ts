import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";
import { isLoopbackAddress } from "./network";

const positiveInteger = z.number().int().positive();

const sessionPolicySchema = z
  .strictObject({
    idleSeconds: positiveInteger,
    absoluteSeconds: positiveInteger,
    maximumConcurrentSessions: positiveInteger.max(128),
  })
  .default({
    idleSeconds: 30 * 60,
    absoluteSeconds: 12 * 60 * 60,
    maximumConcurrentSessions: 8,
  });

const enrollmentPolicySchema = z
  .strictObject({
    keyLifetimeSeconds: positiveInteger,
    maximumOutstandingKeys: positiveInteger.max(128),
  })
  .default({ keyLifetimeSeconds: 15 * 60, maximumOutstandingKeys: 8 });

const connectionPolicySchema = z
  .strictObject({
    requestTimeoutSeconds: positiveInteger.max(300),
    heartbeatTimeoutSeconds: positiveInteger.min(30).max(300),
  })
  .default({ requestTimeoutSeconds: 30, heartbeatTimeoutSeconds: 45 });

const settingsLimitsSchema = z
  .strictObject({
    maximumProfiles: positiveInteger.max(10_000),
    maximumInstructionsPerProfile: positiveInteger.max(10_000),
    maximumPacksPerProfile: positiveInteger.max(10_000),
    maximumPromptsPerProfile: positiveInteger.max(10_000),
    maximumRevisionsPerProfile: positiveInteger.max(10_000),
    maximumDocumentBytes: positiveInteger.max(16 * 1024 * 1024),
    maximumSecretBytes: positiveInteger.max(8 * 1024),
  })
  .default({
    maximumProfiles: 64,
    maximumInstructionsPerProfile: 128,
    maximumPacksPerProfile: 128,
    maximumPromptsPerProfile: 128,
    maximumRevisionsPerProfile: 100,
    maximumDocumentBytes: 1024 * 1024,
    maximumSecretBytes: 8 * 1024,
  });

const settingsManagerSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    encryptionKeyFile: z.string().min(1).optional(),
    encryptionKeyEnvironmentVariable: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    limits: settingsLimitsSchema,
  })
  .default({ enabled: false, limits: settingsLimitsSchema.parse(undefined) });

const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  externalBaseUrl: z.string().url(),
  listen: z.strictObject({
    address: z.string(),
    port: z.number().int().min(1).max(65_535),
  }),
  database: z.strictObject({ path: z.string().min(1) }),
  sessionPolicy: sessionPolicySchema,
  enrollmentPolicy: enrollmentPolicySchema,
  connectionPolicy: connectionPolicySchema,
  settingsManager: settingsManagerSchema,
  previews: z.strictObject({ baseUrl: z.string().url() }).optional(),
});

export type FleetManagerConfig = z.infer<typeof configSchema>;
export type FleetManagerRuntimeMode = "development" | "production";

let loadedEnvironment = false;

export function loadConfig(
  configPath: string,
  runtimeMode: FleetManagerRuntimeMode = "production",
): FleetManagerConfig {
  const absoluteConfigPath = resolve(configPath);
  loadWorkspaceEnvironment(dirname(absoluteConfigPath));
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(absoluteConfigPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read ${absoluteConfigPath}: ${errorMessage(error)}`,
    );
  }
  const result = configSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid Fleet Manager configuration: ${z.prettifyError(result.error)}`,
    );
  }
  const config = result.data;
  validateExternalUrl(config.externalBaseUrl, runtimeMode);
  if (config.previews) {
    const preview = new URL(config.previews.baseUrl);
    const manager = new URL(config.externalBaseUrl);
    const dev =
      runtimeMode === "development" &&
      preview.protocol === "http:" &&
      preview.hostname.endsWith(".localhost");
    if (
      (!dev && preview.protocol !== "https:") ||
      preview.pathname !== "/" ||
      preview.username ||
      preview.password ||
      preview.search ||
      preview.hash ||
      !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/i.test(preview.hostname) ||
      preview.hostname.length > 200 ||
      preview.hostname === manager.hostname ||
      manager.hostname.endsWith(`.${preview.hostname}`)
    ) {
      throw new Error(
        "previews.baseUrl must be a separate HTTPS wildcard base origin, outside the manager hostname. Development accepts HTTP *.localhost.",
      );
    }
  }
  validateListener(config.listen.address);
  if (config.sessionPolicy.idleSeconds > config.sessionPolicy.absoluteSeconds) {
    throw new Error("Session idleSeconds cannot exceed absoluteSeconds.");
  }
  const keySourceCount =
    Number(Boolean(config.settingsManager.encryptionKeyFile)) +
    Number(Boolean(config.settingsManager.encryptionKeyEnvironmentVariable));
  if (config.settingsManager.enabled && keySourceCount !== 1) {
    throw new Error(
      "Enabled Settings Manager requires exactly one encryption key source.",
    );
  }
  const baseDirectory = dirname(absoluteConfigPath);
  config.database.path = resolveFrom(baseDirectory, config.database.path);
  if (config.settingsManager.encryptionKeyFile) {
    config.settingsManager.encryptionKeyFile = resolveFrom(
      baseDirectory,
      config.settingsManager.encryptionKeyFile,
    );
  }
  return config;
}

function loadWorkspaceEnvironment(startDirectory: string): void {
  if (loadedEnvironment) return;
  loadedEnvironment = true;
  let directory = startDirectory;
  const root = parse(directory).root;
  while (true) {
    const environmentPath = resolve(directory, ".env");
    if (existsSync(environmentPath)) {
      loadEnvFile(environmentPath);
      return;
    }
    if (directory === root) return;
    directory = dirname(directory);
  }
}

function validateExternalUrl(
  value: string,
  runtimeMode: FleetManagerRuntimeMode,
): void {
  const url = new URL(value);
  const isDevelopmentLoopbackUrl =
    runtimeMode === "development" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || isLoopbackAddress(url.hostname));
  if (
    (url.protocol !== "https:" && !isDevelopmentLoopbackUrl) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      runtimeMode === "development"
        ? "externalBaseUrl must be an HTTPS origin or a loopback HTTP origin in development."
        : "externalBaseUrl must be an HTTPS origin.",
    );
  }
}

function validateListener(address: string): void {
  if (!isLoopbackAddress(address)) {
    throw new Error("Fleet Manager must listen on a loopback IP address.");
  }
}

function resolveFrom(parent: string, value: string): string {
  return isAbsolute(value) ? value : resolve(parent, value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
