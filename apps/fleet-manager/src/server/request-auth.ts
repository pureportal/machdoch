import { timingSafeEqual } from "node:crypto";
import type { AuthenticatedSession } from "./auth-store";
import { createSecret } from "./crypto";
import { nowSeconds } from "./database";
import { HttpError } from "./errors";
import type { FleetRuntime } from "./runtime";

export const sessionCookieName = "__Host-machdoch_fleet_session";
export const csrfCookieName = "__Host-machdoch_fleet_csrf";
export const csrfHeaderName = "x-machdoch-fleet-csrf";

export function authenticateRequest(
  runtime: FleetRuntime,
  request: Request,
): AuthenticatedSession | null {
  const token = cookieValue(request, sessionCookieName);
  if (!token) return null;
  return runtime.authStore.authenticateSession(
    token,
    nowSeconds(),
    runtime.config.sessionPolicy.idleSeconds,
  );
}

export function requireOwner(
  runtime: FleetRuntime,
  request: Request,
): AuthenticatedSession {
  const session = authenticateRequest(runtime, request);
  if (!session) throw new HttpError(401, "Authentication is required.");
  return session;
}

export function requireMutation(
  runtime: FleetRuntime,
  request: Request,
): AuthenticatedSession {
  const session = requireOwner(runtime, request);
  const cookieToken = cookieValue(request, csrfCookieName);
  const headerToken = request.headers.get(csrfHeaderName);
  if (
    !hasSameOrigin(runtime, request) ||
    !cookieToken ||
    !headerToken ||
    !constantTimeTextEqual(cookieToken, headerToken) ||
    !runtime.authStore.verifySessionCsrf(session.sessionHash, headerToken)
  ) {
    throw new HttpError(403, "Request token is invalid.");
  }
  return session;
}

export function hasSameOrigin(
  runtime: FleetRuntime,
  request: Request,
): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const externalOrigin = new URL(runtime.config.externalBaseUrl).origin;
  const forwardedProtocol = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );
  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const requestUrl = new URL(request.url);
  const protocol = forwardedProtocol
    ? `${forwardedProtocol}:`
    : requestUrl.protocol;
  const host = forwardedHost ?? request.headers.get("host") ?? requestUrl.host;
  return origin === externalOrigin || origin === `${protocol}//${host}`;
}

export function createBrowserCredentials(): {
  sessionToken: string;
  csrfToken: string;
} {
  return {
    sessionToken: createSecret("mch_session"),
    csrfToken: createSecret("mch_csrf"),
  };
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export function sessionCookie(token: string, maximumAge: number): string {
  return `${sessionCookieName}=${token}; Path=/; Max-Age=${maximumAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function csrfCookie(token: string, maximumAge: number): string {
  return `${csrfCookieName}=${token}; Path=/; Max-Age=${maximumAge}; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCsrfCookie(): string {
  return `${csrfCookieName}=; Path=/; Max-Age=0; Secure; SameSite=Strict`;
}

export function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}
