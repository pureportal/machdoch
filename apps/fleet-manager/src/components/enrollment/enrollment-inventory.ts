export interface AvailableGrant {
  grantId: string;
  createdAt: number;
  expiresAt: number;
}

interface EnrollmentInventoryOptions {
  signal: AbortSignal;
  read: (signal: AbortSignal) => Promise<AvailableGrant[]>;
  onInventory: (grants: AvailableGrant[]) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
}

interface InventoryRequest {
  revision: number;
  completion: Promise<void>;
}

export function createEnrollmentInventory({
  signal,
  read,
  onInventory,
  onError,
  onLoading,
}: EnrollmentInventoryOptions) {
  let mutationRevision = 0;
  let mutating = false;
  let refreshRequired = false;
  let activeRequest: InventoryRequest | null = null;

  function refresh(): Promise<void> {
    if (signal.aborted || mutating) return Promise.resolve();
    if (activeRequest) return activeRequest.completion;
    refreshRequired = false;
    const request: InventoryRequest = {
      revision: mutationRevision,
      completion: Promise.resolve(),
    };
    activeRequest = request;
    onLoading(true);
    request.completion = load(request);
    return request.completion;
  }

  async function load(request: InventoryRequest): Promise<void> {
    try {
      const grants = await read(signal);
      if (signal.aborted || request.revision !== mutationRevision) return;
      onInventory(grants);
      onError("");
    } catch (reason) {
      if (!signal.aborted && request.revision === mutationRevision)
        onError(
          reason instanceof Error
            ? reason.message
            : "Keys could not be loaded.",
        );
    } finally {
      activeRequest = null;
      if (!signal.aborted) {
        if (refreshRequired && !mutating) void refresh();
        else if (request.revision === mutationRevision) onLoading(false);
      }
    }
  }

  return {
    signal,
    refresh,
    beginMutation(): boolean {
      if (signal.aborted || mutating) return false;
      mutating = true;
      mutationRevision += 1;
      refreshRequired = true;
      return true;
    },
    finishMutation(): void {
      if (signal.aborted || !mutating) return;
      mutating = false;
      void refresh();
    },
  };
}
