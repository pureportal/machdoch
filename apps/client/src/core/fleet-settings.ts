import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createFleetManagedSettingsEtag,
  fleetManagedSettingsDeliverySchema,
  maximumManagedSettingsDeliveryBytes,
  managedSettingsDocumentSchema,
  type FleetManagedSettingsDocument,
  type FleetManagedSettingsSyncReport,
} from "@machdoch/fleet-protocol";
import { getUserConfigPath } from "./env.js";
import {
  getFleetConnectionPath,
  loadFleetConnectionConfig,
  validateFleetManagerUrl,
  type FleetConnectionConfig,
} from "./fleet-connection.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import {
  USER_API_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
} from "./runtime-contract.generated.js";

type SettingsDelivery = ReturnType<
  typeof fleetManagedSettingsDeliverySchema.parse
>;
class FleetSettingsCacheError extends Error {}
export type FleetManagedProfile = NonNullable<SettingsDelivery["profile"]>;
const supportedSecrets = new Set<string>([
  ...USER_API_PROVIDERS,
  ...USER_WEB_SEARCH_PROVIDERS,
]);
const connectionDigest = (config: FleetConnectionConfig): string =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");

export const getFleetManagedSettingsPath = (): string =>
  join(dirname(getUserConfigPath()), "fleet-managed-settings.json");

async function readCache(
  config: FleetConnectionConfig,
): Promise<SettingsDelivery | null> {
  let content: string;
  try {
    content = await readFile(getFleetManagedSettingsPath(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
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
  if (cached.connectionDigest !== connectionDigest(config)) return null;
  const parsed = fleetManagedSettingsDeliverySchema.safeParse(cached.delivery);
  if (!parsed.success)
    throw new FleetSettingsCacheError("Cached Fleet settings are invalid.");
  const delivery = parsed.data;
  validateDelivery(delivery, config);
  return delivery;
}

export async function loadFleetManagedProfile(): Promise<FleetManagedProfile | null> {
  const config = await loadFleetConnectionConfig();
  if (!config?.enabled) return null;
  return (await readCache(config))?.profile ?? null;
}

function validateDelivery(
  delivery: SettingsDelivery,
  config: FleetConnectionConfig,
): void {
  if (delivery.managerId !== config.managerId)
    throw new Error(
      "Fleet Manager returned settings for another installation.",
    );
  if (
    Object.keys(delivery.profile?.secrets ?? {}).some(
      (id) => !supportedSecrets.has(id),
    )
  )
    throw new Error("Fleet Manager returned an unsupported managed secret.");
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
    connectionDigest(current) !== connectionDigest(config)
  )
    throw new Error("Fleet Manager connection changed during synchronization.");
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

export async function synchronizeFleetSettings(options: {
  config: FleetConnectionConfig;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  captureLocalSettings?: () => Promise<FleetManagedSettingsDocument>;
}): Promise<void> {
  const { config } = options;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const endpoint = new URL(
    `/api/client/settings/${encodeURIComponent(config.instanceId)}`,
    validateFleetManagerUrl(config.managerUrl),
  );
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
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
    if (response.body) await response.body.cancel();
    await discardRejectedCache(response, config, signal);
    if (!response.ok)
      throw new Error(
        `Fleet Manager rejected the settings status report (${response.status}).`,
      );
  };
  try {
    await requireCurrentConnection(config, signal);
    if (!cached && options.captureLocalSettings) {
      const stateResponse = await fetchImplementation(
        `${endpoint}/enrollment`,
        {
          redirect: "manual",
          headers: { Authorization: `Bearer ${config.instanceSecret}` },
          signal,
        },
      );
      if (!stateResponse.ok) {
        if (stateResponse.body) await stateResponse.body.cancel();
        await discardRejectedCache(stateResponse, config, signal);
        throw new Error(
          stateResponse.status === 404
            ? "Update Fleet Manager to capture device settings."
            : `Fleet Manager rejected enrollment settings (${stateResponse.status}).`,
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
          "Fleet Manager returned invalid enrollment settings status.",
        );
      if (state.captureRequired) {
        const document = managedSettingsDocumentSchema.parse(
          await options.captureLocalSettings(),
        );
        await requireCurrentConnection(config, signal);
        const captured = await fetchImplementation(`${endpoint}/enrollment`, {
          method: "PUT",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${config.instanceSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(document),
          signal,
        });
        if (captured.body) await captured.body.cancel();
        await discardRejectedCache(captured, config, signal);
        if (!captured.ok)
          throw new Error(
            `Fleet Manager rejected enrollment settings (${captured.status}).`,
          );
      }
    }
    const response = await fetchImplementation(endpoint, {
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
        if (response.body) await response.body.cancel();
        await discardRejectedCache(response, config, signal);
        throw new Error(
          `Fleet Manager rejected settings synchronization (${response.status}).`,
        );
      }
      delivery = fleetManagedSettingsDeliverySchema.parse(
        await readSettingsResponse(response),
      );
      validateDelivery(delivery, config);
      await withCooperativeFileLock(getFleetConnectionPath(), async () => {
        await requireCurrentConnection(config, signal);
        const path = getFleetManagedSettingsPath();
        await mkdir(dirname(path), { recursive: true });
        if (process.platform !== "win32") await chmod(dirname(path), 0o700);
        await writeJsonAtomically(
          path,
          { connectionDigest: connectionDigest(config), delivery },
          { mode: 0o600 },
        );
      });
    }
    if (!delivery)
      throw new Error(
        "Fleet Manager returned no settings for a changed entity tag.",
      );
    await sendReport({
      status: "applied",
      managerId: config.managerId,
      profileId: delivery.profile?.profileId ?? null,
      revision: delivery.profile?.revision ?? null,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    const message =
      error instanceof Error
        ? error.message
        : "Fleet settings synchronization failed.";
    try {
      await sendReport({
        status: "failed",
        managerId: config.managerId,
        profileId: delivery?.profile?.profileId ?? null,
        revision: delivery?.profile?.revision ?? null,
        error: message.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 1000),
      });
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
