import { invoke } from "@tauri-apps/api/core";
import { canUseTauriStore } from "./_helpers/shell-store-storage.helper";

interface BeginCrossWindowOperationResponse {
  acquired: boolean;
  token?: string | null;
}

interface BrowserOperationLease {
  token: string;
  expiresAt: number;
}

export interface CrossWindowOperationLease {
  operationId: string;
  token: string;
}

const browserLeases = new Map<string, BrowserOperationLease>();
const browserCompletedOperations = new Set<string>();
const browserCompletedOperationOrder: string[] = [];
const MAX_BROWSER_COMPLETED_OPERATIONS = 2_048;

const rememberBrowserCompletedOperation = (operationId: string): void => {
  if (browserCompletedOperations.has(operationId)) {
    return;
  }

  browserCompletedOperations.add(operationId);
  browserCompletedOperationOrder.push(operationId);

  while (browserCompletedOperationOrder.length > MAX_BROWSER_COMPLETED_OPERATIONS) {
    const staleOperationId = browserCompletedOperationOrder.shift();

    if (staleOperationId) {
      browserCompletedOperations.delete(staleOperationId);
    }
  }
};

const createBrowserToken = (): string => {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random()}`;
};

export const beginCrossWindowOperation = async (
  operationId: string,
  leaseMs = 60_000,
): Promise<CrossWindowOperationLease | null> => {
  const normalizedOperationId = operationId.trim();

  if (!normalizedOperationId) {
    throw new Error("Expected a non-empty cross-window operation id.");
  }

  if (canUseTauriStore()) {
    const response = await invoke<BeginCrossWindowOperationResponse>(
      "begin_cross_window_operation",
      {
        request: {
          operationId: normalizedOperationId,
          leaseMs,
        },
      },
    );

    return response.acquired && response.token
      ? { operationId: normalizedOperationId, token: response.token }
      : null;
  }

  const now = Date.now();

  for (const [leasedOperationId, lease] of browserLeases) {
    if (lease.expiresAt <= now) {
      browserLeases.delete(leasedOperationId);
    }
  }

  const existingLease = browserLeases.get(normalizedOperationId);

  if (
    browserCompletedOperations.has(normalizedOperationId) ||
    (existingLease && existingLease.expiresAt > now)
  ) {
    return null;
  }

  const token = createBrowserToken();
  browserLeases.set(normalizedOperationId, {
    token,
    expiresAt: now + Math.max(1, leaseMs),
  });

  return { operationId: normalizedOperationId, token };
};

const settleCrossWindowOperation = async (
  command: "complete_cross_window_operation" | "release_cross_window_operation",
  lease: CrossWindowOperationLease,
): Promise<boolean> => {
  if (canUseTauriStore()) {
    return invoke<boolean>(command, { request: lease });
  }

  const currentLease = browserLeases.get(lease.operationId);

  if (!currentLease || currentLease.token !== lease.token) {
    return false;
  }

  browserLeases.delete(lease.operationId);

  if (command === "complete_cross_window_operation") {
    rememberBrowserCompletedOperation(lease.operationId);
  }

  return true;
};

export const completeCrossWindowOperation = async (
  lease: CrossWindowOperationLease,
): Promise<boolean> => {
  return settleCrossWindowOperation("complete_cross_window_operation", lease);
};

export const releaseCrossWindowOperation = async (
  lease: CrossWindowOperationLease,
): Promise<boolean> => {
  return settleCrossWindowOperation("release_cross_window_operation", lease);
};
