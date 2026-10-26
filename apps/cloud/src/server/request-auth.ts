import { timingSafeEqual } from "node:crypto";
import { hashSecret } from "./crypto";
import { HttpError } from "./errors";
import type { FleetRuntime } from "./runtime";
import { getCloudRuntime } from "./cloud/runtime";
import {
  cloudSessionCookie,
  cloudCsrfCookie,
  cloudCsrfHeader,
} from "./cloud/identity";

export interface AuthenticatedSession {
  username: string;
  sessionId: string;
  sessionHash: string;
  organizationId: string;
  userId: string;
}

export const sessionCookieName = cloudSessionCookie;
export const csrfCookieName = cloudCsrfCookie;
export const csrfHeaderName = cloudCsrfHeader;

export async function authenticateRequest(
  _runtime: FleetRuntime,
  request: Request,
): Promise<AuthenticatedSession | null> {
  const token = cookieValue(request, sessionCookieName);
  if (!token) return null;
  const cloud = await getCloudRuntime();
  const actor = await cloud.identity.authenticate(token);
  if (!actor) return null;
  const user = await cloud.database.transaction(
    async (sql) =>
      (
        await sql.query<{ name: string }>(
          `SELECT u.name FROM cloud_memberships m
      JOIN cloud_users u ON u.id=m.user_id
      JOIN cloud_installation i ON i.organization_id=m.organization_id AND i.id=1
      WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') AND m.active AND NOT u.disabled`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0],
  );
  if (!user)
    throw new HttpError(403, "You do not have access to these clients.");
  const sessionHash = hashSecret(token);
  return { ...actor, username: user.name, sessionId: sessionHash, sessionHash };
}

export async function requireOwner(
  runtime: FleetRuntime,
  request: Request,
): Promise<AuthenticatedSession> {
  const session = await authenticateRequest(runtime, request);
  if (!session) throw new HttpError(401, "Authentication is required.");
  return session;
}

export async function requireMutation(
  runtime: FleetRuntime,
  request: Request,
): Promise<AuthenticatedSession> {
  const session = await requireOwner(runtime, request);
  const cookie = cookieValue(request, csrfCookieName);
  const header = request.headers.get(csrfHeaderName);
  if (
    !hasSameOrigin(runtime, request) ||
    !cookie ||
    !header ||
    !constantTimeTextEqual(cookie, header)
  )
    throw new HttpError(
      403,
      "Your request token expired. Reload the page and try again.",
    );
  const cloud = await getCloudRuntime();
  try {
    if (
      !(await cloud.identity.authenticate(
        cookieValue(request, sessionCookieName)!,
        header,
      ))
    )
      throw new HttpError(401, "Authentication is required.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid_csrf"
    )
      throw new HttpError(
        403,
        "Your request token expired. Reload the page and try again.",
      );
    throw error;
  }
  return session;
}

export function hasSameOrigin(
  runtime: FleetRuntime,
  request: Request,
): boolean {
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    request.headers.get("origin") === runtime.config.externalBaseUrl
  );
}

export async function isRemoteSessionActive(
  sessionHash: string,
): Promise<boolean> {
  const cloud = await getCloudRuntime();
  return cloud.database.transaction(async (sql) =>
    Boolean(
      (
        await sql.query(
          `SELECT 1 FROM cloud_sessions s
    JOIN cloud_memberships m ON m.organization_id=s.organization_id AND m.user_id=s.user_id
    JOIN cloud_installation i ON i.organization_id=s.organization_id AND i.id=1
    WHERE s.token_hash=$1 AND cloud_session_active(s) AND m.role IN ('owner','admin')`,
          [sessionHash],
        )
      ).rows.length,
    ),
  );
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return /^Bearer ([^\s]+)$/iu.exec(authorization ?? "")?.[1] ?? null;
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
