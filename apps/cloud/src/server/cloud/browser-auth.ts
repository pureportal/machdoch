import { CloudError } from "./access";
import { cloudSessionCookie, cloudCsrfCookie } from "./identity";
import {
  rememberedSessionCookie,
  type RememberedCredential,
} from "./auth/remembered-sessions";
import type { CloudRuntime } from "./runtime";

export const cloudSessionMaxAge = 12 * 60 * 60;

export function requireCloudOrigin(
  runtime: CloudRuntime,
  request: Request,
): void {
  if (
    request.headers.get("origin") !== runtime.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new CloudError(
      403,
      "invalid_origin",
      "Open this page from your organization's cloud address.",
    );
}

export function cloudCredentialCookies(
  session: string,
  csrf: string,
  maxAge: number,
): string[] {
  return [
    `${cloudSessionCookie}=${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
    `${cloudCsrfCookie}=${csrf}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`,
  ];
}

export function rememberedSessionCookieHeader(
  remember: RememberedCredential | null,
): string {
  return `${rememberedSessionCookie}=${remember?.token ?? ""}; Path=/; Max-Age=${remember?.maxAge ?? 0}; HttpOnly; Secure; SameSite=Strict`;
}

export function setCloudCredentials(
  response: Response,
  session: string,
  csrf: string,
  maxAge: number,
): Response {
  for (const cookie of cloudCredentialCookies(session, csrf, maxAge))
    response.headers.append("Set-Cookie", cookie);
  return response;
}

export function setRememberedSession(
  response: Response,
  remember: RememberedCredential | null,
): Response {
  response.headers.append(
    "Set-Cookie",
    rememberedSessionCookieHeader(remember),
  );
  return response;
}

export function clearCloudCredentials(response: Response): Response {
  return setRememberedSession(setCloudCredentials(response, "", "", 0), null);
}
