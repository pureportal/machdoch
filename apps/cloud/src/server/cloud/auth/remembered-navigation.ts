import type { IncomingMessage, ServerResponse } from "node:http";
import { cookieHeaderValue } from "../../request-auth";
import {
  cloudCredentialCookies,
  cloudSessionMaxAge,
  rememberedSessionCookieHeader,
} from "../browser-auth";
import { cloudCsrfCookie, cloudSessionCookie } from "../identity";
import type { CloudRuntime } from "../runtime";
import { rememberedSessionCookie } from "./remembered-sessions";

export function replaceRequestCookies(
  header: string | undefined,
  replacements: Record<string, string>,
): string {
  return [
    ...(header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !(part.split("=", 1)[0]! in replacements)),
    ...Object.entries(replacements).map(([name, value]) => `${name}=${value}`),
  ].join("; ");
}

export async function restoreRememberedNavigation(
  runtime: CloudRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const header = request.headers.cookie;
  const rememberToken = cookieHeaderValue(header, rememberedSessionCookie);
  if (!rememberToken) return;
  const result = await runtime.authentication.rememberedSessions.restore(
    cookieHeaderValue(header, cloudSessionCookie) ?? "",
    rememberToken,
  );
  if (result.kind === "unchanged") return;
  if (result.kind === "forgotten") {
    response.appendHeader("Set-Cookie", rememberedSessionCookieHeader(null));
    return;
  }
  request.headers.cookie = replaceRequestCookies(header, {
    [cloudSessionCookie]: result.sessionToken,
    [cloudCsrfCookie]: result.csrfToken,
    ...(result.remember
      ? { [rememberedSessionCookie]: result.remember.token }
      : {}),
  });
  response.appendHeader("Set-Cookie", [
    ...cloudCredentialCookies(
      result.sessionToken,
      result.csrfToken,
      cloudSessionMaxAge,
    ),
    ...(result.remember
      ? [rememberedSessionCookieHeader(result.remember)]
      : []),
  ]);
}
