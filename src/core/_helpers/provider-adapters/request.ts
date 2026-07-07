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
  retryDelayMs?: (attempt: number, error: unknown) => number;
  logger?: ProviderRequestLogger;
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);
const RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
]);
const DEFAULT_PROVIDER_REQUEST_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MAX_MS = 1_000;
const RATE_LIMIT_RETRY_DELAY_BASE_MS = 2_000;
const RATE_LIMIT_RETRY_DELAY_MAX_MS = 30_000;
const RETRY_AFTER_DELAY_MAX_MS = 120_000;

interface ProviderErrorHeaders {
  get: (headerName: string) => string | null | undefined;
}

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

const isProviderErrorHeaders = (
  value: unknown,
): value is ProviderErrorHeaders => {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ProviderErrorHeaders).get === "function"
  );
};

const getErrorHeaders = (
  error: unknown,
): ProviderErrorHeaders | undefined => {
  const headers = getErrorRecord(error)?.headers;

  if (isProviderErrorHeaders(headers)) {
    return headers;
  }

  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }

  const headerEntries = Object.entries(headers as Record<string, unknown>).map(
    ([key, value]) => [key.toLowerCase(), value] as const,
  );

  return {
    get: (headerName: string): string | null => {
      const normalizedHeaderName = headerName.toLowerCase();
      const entry = headerEntries.find(
        ([key]) => key === normalizedHeaderName,
      );
      const value = entry?.[1];

      return typeof value === "string" ? value : null;
    },
  };
};

const getErrorHeader = (
  error: unknown,
  headerName: string,
): string | undefined => {
  const value = getErrorHeaders(error)?.get(headerName);

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
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
  return Math.min(
    DEFAULT_RETRY_DELAY_MAX_MS,
    100 * 2 ** Math.max(0, attempt - 1),
  );
};

const clampRetryDelayMs = (
  delayMs: number,
  maximumMs: number,
): number | undefined => {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    return undefined;
  }

  return Math.min(maximumMs, Math.trunc(delayMs));
};

const parseRetryAfterDelayMs = (error: unknown): number | undefined => {
  const retryAfterMs = getErrorHeader(error, "retry-after-ms");

  if (retryAfterMs) {
    const parsedRetryAfterMs = Number(retryAfterMs);
    const clampedRetryAfterMs = clampRetryDelayMs(
      parsedRetryAfterMs,
      RETRY_AFTER_DELAY_MAX_MS,
    );

    if (clampedRetryAfterMs !== undefined) {
      return clampedRetryAfterMs;
    }
  }

  const retryAfter = getErrorHeader(error, "retry-after");

  if (!retryAfter) {
    return undefined;
  }

  const retryAfterSeconds = Number(retryAfter);
  const clampedRetryAfterSeconds = clampRetryDelayMs(
    retryAfterSeconds * 1_000,
    RETRY_AFTER_DELAY_MAX_MS,
  );

  if (clampedRetryAfterSeconds !== undefined) {
    return clampedRetryAfterSeconds;
  }

  const retryAfterDate = Date.parse(retryAfter);

  return clampRetryDelayMs(
    retryAfterDate - Date.now(),
    RETRY_AFTER_DELAY_MAX_MS,
  );
};

const addRetryJitter = (delayMs: number): number => {
  const jitterFactor = 0.75 + Math.random() * 0.5;

  return Math.max(0, Math.trunc(delayMs * jitterFactor));
};

export const getProviderRequestRetryDelayMs = (
  attempt: number,
  error: unknown,
): number => {
  const retryAfterDelayMs = parseRetryAfterDelayMs(error);

  if (retryAfterDelayMs !== undefined) {
    return retryAfterDelayMs;
  }

  if (getNumericStatus(error) === 429) {
    return addRetryJitter(
      Math.min(
        RATE_LIMIT_RETRY_DELAY_MAX_MS,
        RATE_LIMIT_RETRY_DELAY_BASE_MS * 2 ** Math.max(0, attempt - 1),
      ),
    );
  }

  return defaultRetryDelayMs(attempt);
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

const isRateLimitProviderError = (error: unknown): boolean => {
  const status = getNumericStatus(error);

  if (status === 429) {
    return true;
  }

  const message = getErrorMessage(error);

  return (
    /\b429\b/u.test(message) ||
    /\btoo many requests\b/iu.test(message) ||
    /\brate limit(?:ed)?\b/iu.test(message)
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

const formatDelayMs = (delayMs: number): string => {
  if (delayMs < 1_000) {
    return `${delayMs}ms`;
  }

  return `${Math.ceil(delayMs / 1_000)}s`;
};

const createRateLimitDiagnostic = (
  provider: string,
  error: unknown,
): string => {
  const normalizedProvider = provider.toLowerCase();
  const retryAfterDelayMs = parseRetryAfterDelayMs(error);
  const retryAfterText =
    retryAfterDelayMs !== undefined
      ? ` The provider asked clients to wait about ${formatDelayMs(
          retryAfterDelayMs,
        )} before retrying.`
      : "";
  const baseMessage = `The ${provider} provider returned "429 Too Many Requests", which means the provider rate limit rejected this request.${retryAfterText}`;

  if (normalizedProvider === "langdock") {
    return `${baseMessage} Langdock Chat Completions rate limits are enforced at the workspace level and per model, so GPT-5.5 can return 429 even when the API key and endpoint are valid. Wait for the workspace/model quota to reset, reduce concurrent Machdoch runs or prompt size, or select another available model/provider if the task must continue immediately.`;
  }

  return `${baseMessage} Wait for quota to reset, reduce concurrent runs or prompt size, or select another available model/provider if the task must continue immediately.`;
};

const copyProviderErrorMetadata = (
  target: Error,
  source: unknown,
): Error => {
  const sourceRecord = getErrorRecord(source);

  if (!sourceRecord) {
    return target;
  }

  const metadata: Record<string, unknown> = {};

  for (const fieldName of [
    "status",
    "statusCode",
    "code",
    "type",
    "request_id",
    "requestID",
    "requestId",
    "headers",
  ]) {
    const value = sourceRecord[fieldName];

    if (value !== undefined) {
      metadata[fieldName] = value;
    }
  }

  return Object.assign(target, metadata);
};

const createDiagnosticError = (
  message: string,
  cause: unknown,
): Error => {
  return copyProviderErrorMetadata(new Error(message, { cause }), cause);
};

const normalizeProviderRequestError = (
  options: ProviderRequestOptions,
  error: unknown,
): unknown => {
  if (isRateLimitProviderError(error)) {
    return createDiagnosticError(
      `${createRateLimitDiagnostic(options.provider, error)} Original error: ${getErrorMessage(
        error,
      )}`,
      error,
    );
  }

  if (isNoBodyProviderError(error)) {
    return createDiagnosticError(
      `${createNoBodyDiagnostic(options.provider)} Original error: ${getErrorMessage(
        error,
      )}`,
      error,
    );
  }

  return error;
};

export const withProviderRequest = async <T>(
  options: ProviderRequestOptions,
  execute: (requestSignal: AbortSignal | undefined) => Promise<T>,
): Promise<T> => {
  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestSignal = createProviderRequestSignal(options.signal);
    const startedAt = Date.now();
    let retryableError: unknown;

    try {
      const result = await execute(requestSignal.signal);

      options.logger?.(createLogEntry(options, attempt, startedAt, true));

      return result;
    } catch (error) {
      options.logger?.(
        createLogEntry(options, attempt, startedAt, false, error),
      );
      retryableError = error;

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
      options.retryDelayMs?.(attempt, retryableError) ??
      getProviderRequestRetryDelayMs(attempt, retryableError);
    await sleep(retryDelayMs, options.signal);
  }

  throw new Error("Provider request finished without a result.");
};
