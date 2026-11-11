import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authenticateRequest,
  sessionCookieName,
  type AuthenticatedSession,
} from "./request-auth";
import { getRuntime } from "./runtime";
import { getCloudRuntime } from "./cloud/runtime";

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
  if (!session) {
    const token = (await cookies()).get(sessionCookieName)?.value ?? "";
    const cloud = await getCloudRuntime();
    redirect(
      (await cloud.authentication.twoFactor.challenge(token))
        ? "/cloud/two-factor"
        : "/cloud/login",
    );
  }
  return session;
}
