import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "./env.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";

export const FLEET_CONNECTION_SCHEMA_VERSION = 1;
export const FLEET_CONNECTION_FILE_NAME = "fleet-connection.json";

export interface FleetConnectionConfig {
  schemaVersion: typeof FLEET_CONNECTION_SCHEMA_VERSION;
  enabled: boolean;
  managerUrl: string;
  managerId: string;
  instanceId: string;
  displayName: string;
  instanceSecret: string;
}

export interface FleetConnectionStatus {
  configured: boolean;
  enabled: boolean;
  configPath: string;
  managerUrl?: string;
  managerId?: string;
  instanceId?: string;
  displayName?: string;
}

interface FleetEnrollmentResponse {
  managerId: string;
  managerUrl: string;
  instanceId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const validEncodedValue = (
  value: string,
  prefix: string,
  byteLength: number,
): boolean => {
  const encoded = value.startsWith(`${prefix}_`)
    ? value.slice(prefix.length + 1)
    : "";
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return false;
  try {
    return (
      Buffer.from(encoded, "base64url").byteLength === byteLength &&
      Buffer.from(encoded, "base64url").toString("base64url") === encoded
    );
  } catch {
    return false;
  }
};

const validateDisplayName = (value: string): string => {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > 80 ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new Error("Instance name must contain between 1 and 80 characters.");
  }
  return normalized;
};

const isLoopbackHost = (url: URL): boolean => {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
};

const sourceCliAllowsLoopbackHttp = (): boolean => {
  if (process.env.MACHDOCH_FLEET_ALLOW_LOOPBACK_HTTP === "1") return true;
  return /\.[cm]?ts$/iu.test(process.argv[1] ?? "");
};

export const validateFleetManagerUrl = (
  value: string,
  options: { allowLoopbackHttp?: boolean } = {},
): URL => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new Error("Fleet Manager URL is invalid.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new Error(
      `Fleet Manager URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const allowLoopbackHttp =
    options.allowLoopbackHttp ?? sourceCliAllowsLoopbackHttp();
  if (
    url.protocol !== "https:" &&
    !(allowLoopbackHttp && url.protocol === "http:" && isLoopbackHost(url))
  ) {
    throw new Error(
      allowLoopbackHttp
        ? "Fleet Manager URL must use HTTPS or a loopback HTTP origin in development."
        : "Fleet Manager URL must use HTTPS.",
    );
  }
  if (
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Fleet Manager URL must be an origin.");
  }
  return url;
};

const parseFleetConnectionConfig = (
  value: unknown,
  options: { allowLoopbackHttp?: boolean } = {},
): FleetConnectionConfig => {
  const keys = [
    "schemaVersion",
    "enabled",
    "managerUrl",
    "managerId",
    "instanceId",
    "displayName",
    "instanceSecret",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error("Fleet connection configuration is invalid.");
  }
  if (value.schemaVersion !== FLEET_CONNECTION_SCHEMA_VERSION) {
    throw new Error(
      `Fleet connection schema version ${FLEET_CONNECTION_SCHEMA_VERSION} is required.`,
    );
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.managerUrl !== "string" ||
    typeof value.managerId !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.instanceSecret !== "string"
  ) {
    throw new Error("Fleet connection configuration is invalid.");
  }

  const managerUrl = validateFleetManagerUrl(value.managerUrl, options).origin;
  if (
    !validEncodedValue(value.managerId, "manager", 18) ||
    !validEncodedValue(value.instanceId, "instance", 18) ||
    !validEncodedValue(value.instanceSecret, "mch_instance", 32)
  ) {
    throw new Error("Fleet connection identity is invalid.");
  }

  return {
    schemaVersion: FLEET_CONNECTION_SCHEMA_VERSION,
    enabled: value.enabled,
    managerUrl,
    managerId: value.managerId,
    instanceId: value.instanceId,
    displayName: validateDisplayName(value.displayName),
    instanceSecret: value.instanceSecret,
  };
};

export const getFleetConnectionPath = (): string =>
  join(dirname(getUserConfigPath()), FLEET_CONNECTION_FILE_NAME);

const secureFleetConfigDirectory = async (path: string): Promise<void> => {
  if (process.platform === "win32") return;
  await chmod(dirname(path), 0o700);
};

export const loadFleetConnectionConfig = async (
  options: { allowLoopbackHttp?: boolean } = {},
): Promise<FleetConnectionConfig | null> => {
  const path = getFleetConnectionPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(
      `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return parseFleetConnectionConfig(JSON.parse(raw), options);
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const writeFleetConnectionConfig = async (
  config: FleetConnectionConfig,
  options: { allowLoopbackHttp?: boolean } = {},
): Promise<string> => {
  const path = getFleetConnectionPath();
  const validated = parseFleetConnectionConfig(config, options);
  await withCooperativeFileLock(
    path,
    async () => {
      await mkdir(dirname(path), { recursive: true });
      await secureFleetConfigDirectory(path);
      await writeJsonAtomically(path, validated, { mode: 0o600 });
    },
    { ownerDescription: "Fleet connection configuration" },
  );
  return path;
};

export const setFleetConnectionEnabled = async (
  enabled: boolean,
): Promise<string> => {
  const config = await loadFleetConnectionConfig();
  if (!config) {
    if (enabled) {
      throw new Error(
        "Enroll this CLI with a Fleet Manager before enabling Fleet.",
      );
    }
    return getFleetConnectionPath();
  }
  return await writeFleetConnectionConfig({ ...config, enabled });
};

export const resetFleetConnection = async (): Promise<string> => {
  const path = getFleetConnectionPath();
  await withCooperativeFileLock(
    path,
    async () => {
      await rm(path, { force: true });
    },
    { ownerDescription: "Fleet connection reset" },
  );
  return path;
};

export const loadFleetConnectionStatus =
  async (): Promise<FleetConnectionStatus> => {
    const configPath = getFleetConnectionPath();
    const config = await loadFleetConnectionConfig();
    if (!config) {
      return { configured: false, enabled: false, configPath };
    }
    return {
      configured: true,
      enabled: config.enabled,
      configPath,
      managerUrl: config.managerUrl,
      managerId: config.managerId,
      instanceId: config.instanceId,
      displayName: config.displayName,
    };
  };

const createSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

const parseEnrollmentResponse = (
  value: unknown,
  requestedUrl: URL,
  allowLoopbackHttp: boolean,
): FleetEnrollmentResponse => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["managerId", "managerUrl", "instanceId"]) ||
    typeof value.managerId !== "string" ||
    typeof value.managerUrl !== "string" ||
    typeof value.instanceId !== "string"
  ) {
    throw new Error("Fleet Manager returned an invalid enrollment response.");
  }
  if (
    !validEncodedValue(value.managerId, "manager", 18) ||
    !validEncodedValue(value.instanceId, "instance", 18)
  ) {
    throw new Error(
      "Fleet Manager enrollment identity did not match the requested installation.",
    );
  }
  const returnedUrl = validateFleetManagerUrl(value.managerUrl, {
    allowLoopbackHttp,
  });
  if (
    returnedUrl.origin !== requestedUrl.origin &&
    !(allowLoopbackHttp && requestedUrl.protocol === "http:")
  ) {
    throw new Error(
      "Fleet Manager enrollment identity did not match the requested installation.",
    );
  }
  return {
    managerId: value.managerId,
    managerUrl:
      returnedUrl.origin === requestedUrl.origin
        ? returnedUrl.origin
        : requestedUrl.origin,
    instanceId: value.instanceId,
  };
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const body = await response.text();
  if (Buffer.byteLength(body) > 64 * 1024) {
    throw new Error("Fleet Manager enrollment response was too large.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("Fleet Manager returned an invalid enrollment response.", {
      cause: error,
    });
  }
};

export const enrollFleetConnection = async (options: {
  managerUrl: string;
  enrollmentKey: string;
  displayName: string;
  productVersion: string;
  protocolVersion: number;
  allowLoopbackHttp?: boolean;
  fetch?: typeof globalThis.fetch;
}): Promise<FleetConnectionConfig> => {
  if (
    await loadFleetConnectionConfig({
      ...(options.allowLoopbackHttp !== undefined
        ? { allowLoopbackHttp: options.allowLoopbackHttp }
        : {}),
    })
  ) {
    throw new Error(
      "Reset the current Fleet Manager connection before enrolling again.",
    );
  }
  const allowLoopbackHttp =
    options.allowLoopbackHttp ?? sourceCliAllowsLoopbackHttp();
  const managerUrl = validateFleetManagerUrl(options.managerUrl, {
    allowLoopbackHttp,
  });
  const enrollmentKey = options.enrollmentKey.trim();
  if (!validEncodedValue(enrollmentKey, "mch_enroll", 32)) {
    throw new Error("Enrollment key is invalid.");
  }
  const displayName = validateDisplayName(options.displayName);
  const instanceSecret = createSecret("mch_instance");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const endpoint = new URL("/api/enroll", managerUrl);
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${enrollmentKey}`,
      "Content-Type": "application/json",
      "User-Agent": `Machdoch/${options.productVersion}`,
    },
    body: JSON.stringify({
      displayName,
      instanceSecret,
      productVersion: options.productVersion,
      protocolVersion: options.protocolVersion,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await parseResponseBody(response);
  if (!response.ok) {
    const message =
      isRecord(responseBody) && typeof responseBody.error === "string"
        ? responseBody.error
        : `Fleet Manager rejected enrollment (${response.status}).`;
    throw new Error(message);
  }
  const enrollment = parseEnrollmentResponse(
    responseBody,
    managerUrl,
    allowLoopbackHttp,
  );
  const config: FleetConnectionConfig = {
    schemaVersion: FLEET_CONNECTION_SCHEMA_VERSION,
    enabled: true,
    managerUrl: enrollment.managerUrl,
    managerId: enrollment.managerId,
    instanceId: enrollment.instanceId,
    displayName,
    instanceSecret,
  };
  await writeFleetConnectionConfig(config, { allowLoopbackHttp });
  return config;
};
