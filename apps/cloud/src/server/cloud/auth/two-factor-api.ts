import type { CloudActor } from "../../../lib/cloud-contract";
import {
  authenticatorReplacementSchema,
  twoFactorCodeSchema,
  twoFactorSignInSchema,
} from "../../../lib/cloud-two-factor-contract";
import { cookieValue } from "../../request-auth";
import { CloudError } from "../access";
import {
  cloudSessionMaxAge,
  requireCloudOrigin,
  setCloudCredentials,
  setRememberedSession,
} from "../browser-auth";
import {
  cloudCsrfCookie,
  cloudCsrfHeader,
  cloudSessionCookie,
} from "../identity";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";

export async function handleTwoFactorChallengeApi(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(
    "/api/v1/auth/two-factor/".length,
  );
  if (request.method !== "POST")
    throw new CloudError(405, "method_not_allowed", "Use POST.");
  requireCloudOrigin(runtime, request);
  const token = cookieValue(request, cloudSessionCookie) ?? "";
  const csrf = request.headers.get(cloudCsrfHeader) ?? "";
  if (!csrf || csrf !== cookieValue(request, cloudCsrfCookie))
    throw new CloudError(403, "invalid_csrf", "Reload the page and try again.");
  const service = runtime.authentication.twoFactor;
  if (path === "setup") return Response.json(await service.setup(token, csrf));
  if (path !== "setup/confirm" && path !== "verify")
    throw new CloudError(404, "not_found", "Sign-in action is unavailable.");
  const pending = await service.challenge(token);
  if (!pending)
    throw new CloudError(401, "authentication_required", "Sign in again.");
  await runtime.identity.limitSecondFactor(address, pending.userId);
  const { code, remember } = await readBody(request, twoFactorSignInSchema);
  const result =
    path === "setup/confirm"
      ? await service.confirmSetup(token, csrf, code, remember)
      : await service.verify(token, csrf, code, remember);
  const body =
    "recoveryCodes" in result
      ? { recoveryCodes: result.recoveryCodes }
      : { remainingRecoveryCodes: result.remainingRecoveryCodes };
  return setRememberedSession(
    setCloudCredentials(
      Response.json(body),
      result.sessionToken,
      result.csrfToken,
      cloudSessionMaxAge,
    ),
    result.remember,
  );
}

export async function handleAccountTwoFactorApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
  address: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const token = cookieValue(request, cloudSessionCookie) ?? "";
  const service = runtime.authentication.twoFactor;
  const route = `${request.method} ${path}`;
  if (route === "POST /api/v1/account/two-factor/setup")
    return Response.json(await service.beginReplacement(actor, token));
  if (route === "POST /api/v1/account/two-factor/replace") {
    await runtime.identity.limitSecondFactor(address, actor.userId);
    await service.replace(
      actor,
      token,
      await readBody(request, authenticatorReplacementSchema),
    );
    return Response.json({ ok: true });
  }
  if (route === "POST /api/v1/account/two-factor/recovery-codes") {
    await runtime.identity.limitSecondFactor(address, actor.userId);
    const { code } = await readBody(request, twoFactorCodeSchema);
    return Response.json(
      await service.regenerateRecoveryCodes(actor, token, code),
    );
  }
  throw new CloudError(
    404,
    "not_found",
    "Two-factor authentication action is unavailable.",
  );
}
