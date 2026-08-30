export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method)) {
    const csrfToken = readCookie("__Host-machdoch_fleet_csrf");
    if (csrfToken) headers.set("X-Machdoch-Fleet-CSRF", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!response.ok) {
    const error = new ApiError(
      body?.error ?? `Request failed (${response.status}).`,
      response.status,
    );
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/login"
    ) {
      window.location.replace("/login");
    }
    throw error;
  }
  return body as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
