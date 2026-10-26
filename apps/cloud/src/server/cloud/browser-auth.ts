import { CloudError } from "./access";
import { cloudSessionCookie, cloudCsrfCookie } from "./identity";
import type { CloudRuntime } from "./runtime";

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
export function setCloudCredentials(
  response: Response,
  session: string,
  csrf: string,
  maxAge: number,
): Response {
  response.headers.append(
    "Set-Cookie",
    `${cloudSessionCookie}=${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
  );
  response.headers.append(
    "Set-Cookie",
    `${cloudCsrfCookie}=${csrf}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`,
  );
  return response;
}
