export interface ProviderRequestLogEntry {
  provider: string;
  operation: string;
  attempt: number;
  elapsedMs: number;
  ok: boolean;
  errorName?: string;
  errorMessage?: string;
}

export type ProviderRequestLogger = (entry: ProviderRequestLogEntry) => void;

export interface ProviderRequestOptions {
  provider: string;
  operation: string;
  signal?: AbortSignal | undefined;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  logger?: ProviderRequestLogger;
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const DEFAULT_PROVIDER_REQUEST_MAX_ATTEMPTS = 2;

const getErrorRecord = (
  error: unknown,
): Record<string, unknown> | undefined => {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : undefined;
};

const getStringProperty = (
  error: unknown,
  propertyName: string,
): string | undefined => {
  const value = getErrorRecord(error)?.[propertyName];

  return typeof value === "string" ? value : undefined;
};

const getNumericStatus = (error: unknown): number | undefined => {
  const record = getErrorRecord(error);
  const status = record?.status ?? record?.statusCode;

  return typeof status === "number" ? status : undefined;
};

const isAbortLikeError = (error: unknown): boolean => {
  const name = getStringProperty(error, "name");
  const code = getStringProperty(error, "code");

  return name === "AbortError" || code === "ABORT_ERR";
};

export const isRetryableProviderRequestError = (error: unknown): boolean => {
  if (isAbortLikeError(error)) {
    return false;
  }

  const status = getNumericStatus(error);

  if (status !== undefined) {
    return status >= 500 || RETRYABLE_STATUS_CODES.has(status);
  }

  const code = getStringProperty(error, "code");

  if (code && RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const name = getStringProperty(error, "name")?.toLowerCase() ?? "";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);

  return (
    name.includes("timeout") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded")
  );
};

export const createProviderRequestSignal = (
  sourceSignal: AbortSignal | undefined,
): {
  signal?: AbortSignal;
  cleanup: () => void;
} => {
  if (!sourceSignal) {
    return {
      cleanup: (): void => {},
    };
  }

  const abortController = new AbortController();
  const forwardAbort = (): void => {
    if (!abortController.signal.aborted) {
      abortController.abort(sourceSignal.reason);
    }
  };

  if (sourceSignal.aborted) {
    forwardAbort();

    return {
      signal: abortController.signal,
      cleanup: (): void => {},
    };
  }

  sourceSignal.addEventListener("abort", forwardAbort, { once: true });

  return {
    signal: abortController.signal,
    cleanup: (): void => {
      sourceSignal.removeEventListener("abort", forwardAbort);
    },
  };
};

const normalizeMaxAttempts = (maxAttempts: number | undefined): number => {
  if (
    typeof maxAttempts !== "number" ||
    !Number.isFinite(maxAttempts) ||
    maxAttempts < 1
  ) {
    return DEFAULT_PROVIDER_REQUEST_MAX_ATTEMPTS;
  }

  return Math.trunc(maxAttempts);
};

const defaultRetryDelayMs = (attempt: number): number => {
  return Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
};

const createAbortError = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Provider request aborted.");
};

const sleep = async (
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    const handleAbort = (): void => {
      clearTimeout(timeout);
      reject(signal ? createAbortError(signal) : new Error("Aborted."));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
};

const createLogEntry = (
  options: ProviderRequestOptions,
  attempt: number,
  startedAt: number,
  ok: boolean,
  error?: unknown,
): ProviderRequestLogEntry => {
  const entry: ProviderRequestLogEntry = {
    provider: options.provider,
    operation: options.operation,
    attempt,
    elapsedMs: Date.now() - startedAt,
    ok,
  };

  if (!ok && error !== undefined) {
    const name = getStringProperty(error, "name");
    const message = error instanceof Error ? error.message : String(error);

    if (name) {
      entry.errorName = name;
    }

    if (message.length > 0) {
      entry.errorMessage = message;
    }
  }

  return entry;
};

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const isNoBodyProviderError = (error: unknown): boolean => {
  const status = getNumericStatus(error);
  const message = getErrorMessage(error);

  if (!/\bNo body\b/i.test(message)) {
    return false;
  }

  return (
    status === 400 ||
    (status === undefined && /\b400\s+No body\b/i.test(message))
  );
};

const createNoBodyDiagnostic = (provider: string): string => {
  const normalizedProvider = provider.toLowerCase();
  const baseMessage = `The ${provider} provider returned "400 No body", which means the configured API endpoint reported that it received an empty HTTP request body. Machdoch had already constructed the provider payload before calling the SDK, so verify the provider base URL and any proxy between Machdoch and the provider.`;

  if (normalizedProvider === "langdock") {
    return `${baseMessage} If LANGDOCK_BASE_URL is set, use either the Langdock API root, for example https://api.langdock.com or https://<your-domain>/api/public for a dedicated deployment, or one of Langdock's documented provider bases such as https://api.langdock.com/openai/eu/v1, https://api.langdock.com/anthropic/eu/v1, or https://api.langdock.com/google/eu/v1beta. Machdoch normalizes recognized roots and provider URLs with LANGDOCK_REGION before calling Langdock.`;
  }

  return baseMessage;
};

const normalizeProviderRequestError = (
  options: ProviderRequestOptions,
  error: unknown,
): unknown => {
  if (!isNoBodyProviderError(error)) {
    return error;
  }

  return new Error(
    `${createNoBodyDiagnostic(options.provider)} Original error: ${getErrorMessage(
      error,
    )}`,
    { cause: error },
  );
};

export const withProviderRequest = async <T>(
  options: ProviderRequestOptions,
  execute: (requestSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> => {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestSignal = createProviderRequestSignal(options.signal);
    const startedAt = Date.now();

    try {
      const result = await execute(requestSignal.signal);

      options.logger?.(createLogEntry(options, attempt, startedAt, true));

      return result;
    } catch (error) {
      options.logger?.(
        createLogEntry(options, attempt, startedAt, false, error),
      );

      if (
        attempt >= maxAttempts ||
        !isRetryableProviderRequestError(error)
      ) {
        throw normalizeProviderRequestError(options, error);
      }
    } finally {
      requestSignal.cleanup();
    }

    const retryDelayMs =
      options.retryDelayMs?.(attempt) ?? defaultRetryDelayMs(attempt);
    await sleep(retryDelayMs, options.signal);
  }

  throw new Error("Provider request finished without a result.");
};
