import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createFleetManagedSettingsEtag,
  fleetManagedSettingsDeliverySchema,
  managedSettingsDocumentSchema,
  managedSettingsSchemaVersion,
  maximumManagedSettingsDeliveryBytes,
  type FleetManagedSettingsDocument,
  type FleetManagedSettingsSyncReport,
} from "@machdoch/fleet-protocol";
import {
  getFleetConnectionPath,
  getFleetManagedSettingsPath,
  loadFleetConnectionConfig,
  loadFleetConnectionConfigSync,
  validateCloudServerUrl,
  type FleetConnectionConfig,
} from "./fleet-connection.js";
import { managedMcpServerWarnings } from "./fleet-mcp.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";

export { getFleetManagedSettingsPath } from "./fleet-connection.js";

type SettingsDelivery = ReturnType<
  typeof fleetManagedSettingsDeliverySchema.parse
>;
class FleetSettingsCacheError extends Error {}
class FleetConnectionChangedError extends Error {
  constructor() {
    super("machdoch.cloud connection changed during synchronization.");
  }
}
export type FleetManagedProfile = NonNullable<SettingsDelivery["profile"]>;

/**
 * Identifies the enrollment a cached delivery belongs to. The desktop shell
 * computes the same value natively, so the input must stay a plain tuple.
 */
export const fleetConnectionDigest = (config: FleetConnectionConfig): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        config.managerUrl,
        config.managerId,
        config.instanceId,
        config.instanceSecret,
        config.enabled,
      ]),
    )
    .digest("hex");

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

async function readCache(
  config: FleetConnectionConfig,
): Promise<SettingsDelivery | null> {
  let content: string;
  try {
    content = await readFile(getFleetManagedSettingsPath(), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  return parseCache(content, config);
}

function parseCache(
  content: string,
  config: FleetConnectionConfig,
): SettingsDelivery | null {
  if (Buffer.byteLength(content) > maximumManagedSettingsDeliveryBytes + 1024)
    throw new FleetSettingsCacheError(
      "Cached Fleet settings exceed the size limit.",
    );
  let cached: unknown;
  try {
    cached = JSON.parse(content);
  } catch (error) {
    throw new FleetSettingsCacheError("Cached Fleet settings are invalid.", {
      cause: error,
    });
  }
  if (
    typeof cached !== "object" ||
    cached === null ||
    !("connectionDigest" in cached) ||
    !("delivery" in cached) ||
    Object.keys(cached).length !== 2 ||
    typeof cached.connectionDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(cached.connectionDigest)
  )
    throw new FleetSettingsCacheError("Cached Fleet settings are invalid.");
  if (cached.connectionDigest !== fleetConnectionDigest(config)) return null;
  const parsed = fleetManagedSettingsDeliverySchema.safeParse(cached.delivery);
  if (!parsed.success || parsed.data.managerId !== config.managerId)
    throw new FleetSettingsCacheError("Cached Fleet settings are invalid.");
  return parsed.data;
}

export async function loadFleetManagedProfile(): Promise<FleetManagedProfile | null> {
  const config = await loadFleetConnectionConfig();
  if (!config?.enabled) return null;
  return (await readCache(config))?.profile ?? null;
}

/** Synchronous variant for configuration readers that cannot await. */
export function loadFleetManagedProfileSync(): FleetManagedProfile | null {
  const config = loadFleetConnectionConfigSync();
  if (!config?.enabled) return null;
  let content: string;
  try {
    content = readFileSync(getFleetManagedSettingsPath(), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  return parseCache(content, config)?.profile ?? null;
}

async function requireCurrentConnection(
  config: FleetConnectionConfig,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const current = await loadFleetConnectionConfig();
  signal.throwIfAborted();
  if (
    !current?.enabled ||
    fleetConnectionDigest(current) !== fleetConnectionDigest(config)
  )
    throw new FleetConnectionChangedError();
}

async function discardRejectedCache(
  response: Response,
  config: FleetConnectionConfig,
  signal: AbortSignal,
): Promise<void> {
  if (response.status !== 401 && response.status !== 403) return;
  await withCooperativeFileLock(getFleetConnectionPath(), async () => {
    await requireCurrentConnection(config, signal);
    await rm(getFleetManagedSettingsPath(), { force: true });
  });
}

async function readSettingsResponse(
  response: Response,
  maximumBytes = maximumManagedSettingsDeliveryBytes,
): Promise<unknown> {
  if (Number(response.headers.get("Content-Length")) > maximumBytes)
    throw new Error("Fleet settings response exceeded the size limit.");
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maximumBytes)
          throw new Error("Fleet settings response exceeded the size limit.");
        chunks.push(result.value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const settingsEndpoint = (config: FleetConnectionConfig): URL =>
  new URL(
    `/api/client/settings/${encodeURIComponent(config.instanceId)}`,
    validateCloudServerUrl(config.managerUrl),
  );

export interface FleetSettingsSnapshotStatus {
  requested: boolean;
  capturedAt: number | null;
}

const parseSnapshotStatus = (value: unknown): FleetSettingsSnapshotStatus => {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== 2 ||
    !("requested" in value) ||
    !("capturedAt" in value) ||
    typeof value.requested !== "boolean" ||
    (value.capturedAt !== null &&
      (typeof value.capturedAt !== "number" ||
        !Number.isFinite(value.capturedAt) ||
        value.capturedAt < 0))
  )
    throw new Error("machdoch.cloud returned invalid device settings status.");
  return { requested: value.requested, capturedAt: value.capturedAt };
};

/**
 * Builds the acknowledgement for a delivery. Version 3 deliveries report each
 * assigned layer; version 2 clouds only understand the legacy body.
 */
export function createFleetSettingsReport(
  managerId: string,
  delivery: SettingsDelivery | null,
  result:
    | { status: "applied"; warnings?: string[] }
    | {
        status: "failed";
        error: string;
      },
): FleetManagedSettingsSyncReport {
  const identity = {
    managerId,
    profileId: delivery?.profile?.profileId ?? null,
    revision: delivery?.profile?.revision ?? null,
  };
  const layers =
    delivery?.schemaVersion === managedSettingsSchemaVersion &&
    delivery.layers?.length
      ? delivery.layers.map((layer) => ({
          profileId: layer.profileId,
          revision: layer.revision,
        }))
      : undefined;
  if (result.status === "failed")
    return {
      status: "failed",
      ...identity,
      error:
        reportText(result.error, 1000) ||
        "Fleet settings synchronization failed.",
      ...(layers ? { layers } : {}),
    };
  const warnings =
    delivery?.schemaVersion === managedSettingsSchemaVersion
      ? [
          ...new Set(
            (result.warnings ?? [])
              .map((warning) => reportText(warning, 500))
              .filter(Boolean),
          ),
        ].slice(0, 32)
      : [];
  return {
    status: "applied",
    ...identity,
    ...(layers ? { layers } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

const reportText = (value: string, maximum: number): string =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, maximum);

async function cancelBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

/**
 * Uploads the device baseline to the current snapshot endpoint. Returns false
 * when machdoch.cloud predates snapshots so callers can use the legacy capture.
 */
export async function uploadFleetSettingsSnapshot(options: {
  config: FleetConnectionConfig;
  document: FleetManagedSettingsDocument;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const document = managedSettingsDocumentSchema.parse(options.document);
  await requireCurrentConnection(options.config, options.signal);
  const response = await fetchImplementation(
    `${settingsEndpoint(options.config)}/snapshot`,
    {
      method: "PUT",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${options.config.instanceSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(document),
      signal: options.signal,
    },
  );
  await cancelBody(response);
  if (response.status === 404) return false;
  await discardRejectedCache(response, options.config, options.signal);
  if (!response.ok)
    throw new Error(
      `machdoch.cloud rejected device settings (${response.status}).`,
    );
  return true;
}

export async function getFleetSettingsSnapshotStatus(options: {
  config: FleetConnectionConfig;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<FleetSettingsSnapshotStatus | null> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  await requireCurrentConnection(options.config, options.signal);
  const response = await fetchImplementation(
    `${settingsEndpoint(options.config)}/snapshot`,
    {
      redirect: "manual",
      headers: { Authorization: `Bearer ${options.config.instanceSecret}` },
      signal: options.signal,
    },
  );
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok) {
    await cancelBody(response);
    await discardRejectedCache(response, options.config, options.signal);
    throw new Error(
      `machdoch.cloud rejected device settings status (${response.status}).`,
    );
  }
  return parseSnapshotStatus(await readSettingsResponse(response, 1024));
}

async function captureLegacyEnrollment(
  endpoint: URL,
  config: FleetConnectionConfig,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  captureLocalSettings: () => Promise<FleetManagedSettingsDocument>,
): Promise<void> {
  const stateResponse = await fetchImplementation(`${endpoint}/enrollment`, {
    redirect: "manual",
    headers: { Authorization: `Bearer ${config.instanceSecret}` },
    signal,
  });
  if (!stateResponse.ok) {
    await cancelBody(stateResponse);
    await discardRejectedCache(stateResponse, config, signal);
    throw new Error(
      stateResponse.status === 404
        ? "Update machdoch.cloud to capture device settings."
        : `machdoch.cloud rejected enrollment settings (${stateResponse.status}).`,
    );
  }
  const state = await readSettingsResponse(stateResponse, 1024);
  if (
    typeof state !== "object" ||
    state === null ||
    !("captureRequired" in state) ||
    typeof state.captureRequired !== "boolean" ||
    Object.keys(state).length !== 1
  )
    throw new Error(
      "machdoch.cloud returned invalid enrollment settings status.",
    );
  if (!state.captureRequired) return;
  const document = managedSettingsDocumentSchema.parse(
    await captureLocalSettings(),
  );
  // Clouds without snapshots predate schema version 3 documents.
  const { policy: _policy, mcpServers: _mcpServers, ...legacy } = document;
  await requireCurrentConnection(config, signal);
  const captured = await fetchImplementation(`${endpoint}/enrollment`, {
    method: "PUT",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${config.instanceSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(legacy),
    signal,
  });
  await cancelBody(captured);
  await discardRejectedCache(captured, config, signal);
  if (!captured.ok)
    throw new Error(
      `machdoch.cloud rejected enrollment settings (${captured.status}).`,
    );
}

/** Uploads the device baseline when machdoch.cloud asks for it. */
async function uploadRequestedSnapshot(
  endpoint: URL,
  config: FleetConnectionConfig,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
  captureLocalSettings: () => Promise<FleetManagedSettingsDocument>,
  forceSnapshot: boolean,
): Promise<void> {
  const status = await getFleetSettingsSnapshotStatus({
    config,
    signal,
    fetch: fetchImplementation,
  });
  if (status === null) {
    await captureLegacyEnrollment(
      endpoint,
      config,
      signal,
      fetchImplementation,
      captureLocalSettings,
    );
  } else if (status.requested || forceSnapshot) {
    await uploadFleetSettingsSnapshot({
      config,
      document: await captureLocalSettings(),
      signal,
      fetch: fetchImplementation,
    });
  }
}

export async function synchronizeFleetSettings(options: {
  config: FleetConnectionConfig;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  captureLocalSettings?: () => Promise<FleetManagedSettingsDocument>;
  /** Upload the device baseline even when machdoch.cloud did not ask for it. */
  forceSnapshot?: boolean;
}): Promise<void> {
  const { config } = options;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const endpoint = settingsEndpoint(config);
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  const warnings: string[] = [];
  let cached: SettingsDelivery | null;
  try {
    cached = await readCache(config);
  } catch (error) {
    if (!(error instanceof FleetSettingsCacheError)) throw error;
    cached = null;
  }
  let delivery = cached;
  const sendReport = async (
    report: FleetManagedSettingsSyncReport,
  ): Promise<void> => {
    await requireCurrentConnection(config, signal);
    const response = await fetchImplementation(`${endpoint}/sync-status`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${config.instanceSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report),
      signal,
    });
    await cancelBody(response);
    await discardRejectedCache(response, config, signal);
    if (!response.ok)
      throw new Error(
        `machdoch.cloud rejected the settings status report (${response.status}).`,
      );
  };
  try {
    await requireCurrentConnection(config, signal);
    if (options.captureLocalSettings) {
      // Uploading the baseline must never keep managed settings from applying.
      try {
        await uploadRequestedSnapshot(
          endpoint,
          config,
          signal,
          fetchImplementation,
          options.captureLocalSettings,
          options.forceSnapshot ?? false,
        );
      } catch (error) {
        if (signal.aborted || error instanceof FleetConnectionChangedError)
          throw error;
        warnings.push(
          `Device settings could not be uploaded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const deliveryUrl = new URL(endpoint);
    deliveryUrl.searchParams.set(
      "schemaVersion",
      String(managedSettingsSchemaVersion),
    );
    const response = await fetchImplementation(deliveryUrl, {
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${config.instanceSecret}`,
        ...(cached
          ? { "If-None-Match": createFleetManagedSettingsEtag(cached) }
          : {}),
      },
      signal,
    });
    if (response.status !== 304) {
      if (!response.ok) {
        await cancelBody(response);
        await discardRejectedCache(response, config, signal);
        throw new Error(
          `machdoch.cloud rejected settings synchronization (${response.status}).`,
        );
      }
      const fetched = fleetManagedSettingsDeliverySchema.parse(
        await readSettingsResponse(response),
      );
      if (fetched.managerId !== config.managerId)
        throw new Error(
          "machdoch.cloud returned settings for another installation.",
        );
      delivery = fetched;
      await withCooperativeFileLock(getFleetConnectionPath(), async () => {
        await requireCurrentConnection(config, signal);
        const path = getFleetManagedSettingsPath();
        await mkdir(dirname(path), { recursive: true });
        if (process.platform !== "win32") await chmod(dirname(path), 0o700);
        await writeJsonAtomically(
          path,
          {
            connectionDigest: fleetConnectionDigest(config),
            delivery: fetched,
          },
          { mode: 0o600 },
        );
      });
    }
    if (!delivery)
      throw new Error(
        "machdoch.cloud returned no settings for a changed entity tag.",
      );
    if (delivery.profile)
      warnings.push(...managedMcpServerWarnings(delivery.profile));
    await sendReport(
      createFleetSettingsReport(config.managerId, delivery, {
        status: "applied",
        warnings,
      }),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const message =
      error instanceof Error
        ? error.message
        : "Fleet settings synchronization failed.";
    try {
      await sendReport(
        createFleetSettingsReport(config.managerId, delivery, {
          status: "failed",
          error: message,
        }),
      );
    } catch (reportError) {
      throw new AggregateError(
        [error, reportError],
        `${message} The sync failure could not be reported.`,
      );
    }
    throw error;
  }
}

export async function runFleetSettingsService(options: {
  signal: AbortSignal;
  onError: (error: unknown) => void;
  intervalMs?: number;
  captureLocalSettings?: () => Promise<FleetManagedSettingsDocument>;
}): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const config = await loadFleetConnectionConfig();
      if (config?.enabled)
        await synchronizeFleetSettings({
          config,
          signal: options.signal,
          ...(options.captureLocalSettings
            ? { captureLocalSettings: options.captureLocalSettings }
            : {}),
        });
    } catch (error) {
      if (!options.signal.aborted) options.onError(error);
    }
    if (options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, options.intervalMs ?? 30_000);
      options.signal.addEventListener("abort", finish, { once: true });
      if (options.signal.aborted) finish();
    });
  }
}
