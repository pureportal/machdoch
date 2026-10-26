import {
  invitationAcceptSchema,
  invitationConfirmationSchema,
  invitationPrepareSchema,
} from "../../../lib/cloud-invitation-contract";
import { hashSecret } from "../../crypto";
import { cookieValue } from "../../request-auth";
import { CloudError } from "../access";
import { requireCloudOrigin, setCloudCredentials } from "../browser-auth";
import { cloudSessionCookie } from "../identity";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import {
  invitationCookie,
  ssoBrowserCookie,
  setProofCookie,
} from "./proof-cookies";
import { browserSessionContext } from "./session-context";

export async function handleInvitationAccess(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  if (request.method !== "POST")
    throw new CloudError(
      405,
      "method_not_allowed",
      "Open the invitation link to continue.",
    );
  requireCloudOrigin(runtime, request);
  const path = new URL(request.url).pathname;
  const invitations = runtime.authentication.invitations;
  const browser = cookieValue(request, invitationCookie) ?? "";
  const session = cookieValue(request, cloudSessionCookie) ?? "";
  const ssoBrowser = cookieValue(request, ssoBrowserCookie) ?? "";
  if (path.endsWith("/prepare")) {
    const input = await readBody(request, invitationPrepareSchema);
    await runtime.identity.limitMagicProof(address, hashSecret(input.token));
    const result = await invitations.prepare(
      input.token,
      browser,
      session,
      ssoBrowser,
    );
    return setProofCookie(
      Response.json(result.preview),
      "invitation",
      result.nonce,
    );
  }
  if (path.endsWith("/accept")) {
    const input = await readBody(request, invitationAcceptSchema);
    await runtime.identity.limitMagicProof(address, input.confirmationId);
    const preview = await invitations.inspect(
      input.confirmationId,
      browser,
      session,
      ssoBrowser,
    );
    if (
      !preview.completed &&
      preview.authentication === "password" &&
      !preview.canUseSession
    )
      await runtime.identity.limitLogin(address, preview.email);
    const result = await runtime.authentication.invitationAcceptance.accept(
      input,
      browser,
      session,
      ssoBrowser,
      browserSessionContext(request, address),
    );
    return setCloudCredentials(
      Response.json({ redirect: result.redirect }),
      result.sessionToken,
      result.csrfToken,
      12 * 3600,
    );
  }
  const input = await readBody(request, invitationConfirmationSchema);
  await runtime.identity.limitMagicProof(address, input.confirmationId);
  if (path.endsWith("/preview"))
    return Response.json(
      await invitations.inspect(
        input.confirmationId,
        browser,
        session,
        ssoBrowser,
      ),
    );
  if (path.endsWith("/sso")) {
    const result = await invitations.startSso(
      input.confirmationId,
      browser,
      ssoBrowser,
    );
    return setProofCookie(
      Response.json({ url: result.url }),
      "sso",
      result.nonce,
    );
  }
  throw new CloudError(
    404,
    "not_found",
    "This invitation action is unavailable.",
  );
}
