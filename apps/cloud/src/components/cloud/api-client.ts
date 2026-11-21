export class CloudRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export function csrfToken(): string {
  return (
    document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith("__Host-machdoch_cloud_csrf="))
      ?.split("=")[1] ?? ""
  );
}

export async function cloudRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    headers["x-machdoch-cloud-csrf"] = csrfToken();
    if (options.key) headers["Idempotency-Key"] = options.key;
  }
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const deadline = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 30_000);
  try {
    const response = await fetch(`/api/v1/${path}`, {
      method,
      headers,
      body,
      signal,
      cache: "no-store",
    });
    const value: unknown = await response.json().catch((reason: unknown) => {
      if (signal.aborted) throw reason;
      throw new CloudRequestError(
        "Cloud returned an invalid response. Try again.",
        response.status,
        "invalid_response",
      );
    });
    if (!response.ok) {
      const error =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : "Request failed. Try again.";
      const code =
        value &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string"
          ? value.code
          : "unknown";
      throw new CloudRequestError(error, response.status, code);
    }
    return value as T;
  } catch (reason) {
    if (reason instanceof CloudRequestError || options.signal?.aborted)
      throw reason;
    if (deadline.signal.aborted)
      throw new CloudRequestError(
        "The request timed out before confirmation. Try again.",
        408,
        "request_timeout",
      );
    throw new CloudRequestError(
      "Cloud did not confirm the request. Check your connection and try again.",
      0,
      "network_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function cloudUpload<T>(
  path: string,
  file: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/v1/${path}`);
    request.responseType = "json";
    request.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    request.setRequestHeader("x-machdoch-cloud-csrf", csrfToken());
    if (onProgress)
      request.upload.onprogress = (event) =>
        onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onload = () => {
      const value = request.response as
        | (T & { error?: string; code?: string })
        | null;
      if (request.status >= 200 && request.status < 300) resolve(value as T);
      else
        reject(
          new CloudRequestError(
            value?.error ?? "The upload failed. Try again.",
            request.status,
            value?.code ?? "unknown",
          ),
        );
    };
    request.onerror = () =>
      reject(
        new CloudRequestError(
          "The upload was interrupted. Check your connection and try again.",
          0,
          "network_unavailable",
        ),
      );
    request.send(file);
  });
}

export function formText(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}
export function formReference(form: FormData, name: string): string | null {
  return formText(form, name) || null;
}

export function createCommandSender() {
  let previous: { serialized: string; key: string } | null = null;
  return async <T>(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<T> => {
    const serialized = JSON.stringify({ path, body, method });
    if (previous?.serialized !== serialized)
      previous = { serialized, key: crypto.randomUUID() };
    const attempt = previous;
    const result = await cloudRequest<T>(path, {
      method,
      body,
      key: attempt.key,
    });
    if (previous === attempt) previous = null;
    return result;
  };
}
