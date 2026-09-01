import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { AuthenticatedSession } from "./auth-store";
import { validateSecret } from "./crypto";
import { nowSeconds } from "./database";
import { sessionCookieName } from "./request-auth";
import { getRuntime } from "./runtime";

export async function pageSession(): Promise<AuthenticatedSession | null> {
  const token = (await cookies()).get(sessionCookieName)?.value;
  if (!token || !validateSecret(token, "mch_session")) return null;
  const runtime = getRuntime();
  return runtime.authStore.authenticateSession(
    token,
    nowSeconds(),
    runtime.config.sessionPolicy.idleSeconds,
  );
}

export async function requirePageSession(): Promise<AuthenticatedSession> {
  const session = await pageSession();
  if (!session) redirect("/login");
  return session;
}
