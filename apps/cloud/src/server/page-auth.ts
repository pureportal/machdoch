import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authenticateRequest,
  sessionCookieName,
  type AuthenticatedSession,
} from "./request-auth";
import { getRuntime } from "./runtime";

export async function pageSession(): Promise<AuthenticatedSession | null> {
  const token = (await cookies()).get(sessionCookieName)?.value;
  if (!token) return null;
  return authenticateRequest(
    getRuntime(),
    new Request("https://cloud.invalid", {
      headers: { Cookie: `${sessionCookieName}=${token}` },
    }),
  );
}

export async function requirePageSession(): Promise<AuthenticatedSession> {
  const session = await pageSession();
  if (!session) redirect("/cloud/login");
  return session;
}
