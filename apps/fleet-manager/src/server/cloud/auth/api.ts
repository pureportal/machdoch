import { cloudId } from "../../../lib/cloud-contract";
import {
  emailSettingsInputSchema,
  emailConnectionCheckSchema,
  magicLinkRequestSchema,
  magicLinkPrepareSchema,
  magicLinkConfirmationSchema,
} from "../../../lib/cloud-email-contract";
import { hashSecret } from "../../crypto";
import { cookieValue } from "../../request-auth";
import { CloudError, checkRevision } from "../access";
import { requireCloudOrigin, setCloudCredentials } from "../browser-auth";
import { cloudSessionCookie } from "../identity";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import type { CloudActor } from "../../../lib/cloud-contract";
import { magicConfirmationCookie, setProofCookie } from "./proof-cookies";
import { MailDeliveryError, verifySmtpConnection } from "./smtp";
import { browserSessionContext } from "./session-context";
const activeConnectionChecks = new Set<string>();

export async function handleMagicLinkApi(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/v1/auth/methods")
    return Response.json({
      magicLink: await runtime.authentication.magicLinks.available(),
      password: await runtime.authentication.signinPolicy.passwordAvailable(),
      sso: await runtime.authentication.ssoFlows.available(),
    });
  if (request.method !== "POST")
    throw new CloudError(
      405,
      "method_not_allowed",
      "Use the sign-in page to continue.",
    );
  requireCloudOrigin(runtime, request);
  const magic = runtime.authentication.magicLinks;
  if (path === "/api/v1/auth/magic/request") {
    const input = await readBody(request, magicLinkRequestSchema);
    await runtime.identity.limitLogin(address, input.email);
    await magic.request(input);
    runtime.authentication.mailWorker.wake();
    return Response.json({ ok: true }, { status: 202 });
  }
  const session = cookieValue(request, cloudSessionCookie) ?? "";
  if (path === "/api/v1/auth/magic/prepare") {
    const input = await readBody(request, magicLinkPrepareSchema);
    await runtime.identity.limitMagicProof(address, hashSecret(input.token));
    const result = await magic.prepare(
      input.token,
      await runtime.identity.authenticate(session),
      cookieValue(request, magicConfirmationCookie) ?? undefined,
    );
    return setProofCookie(Response.json(result.preview), "magic", result.nonce);
  }
  if (
    path === "/api/v1/auth/magic/preview" ||
    path === "/api/v1/auth/magic/consume"
  ) {
    const input = await readBody(request, magicLinkConfirmationSchema);
    await runtime.identity.limitMagicProof(address, input.confirmationId);
    const nonce = cookieValue(request, magicConfirmationCookie) ?? "";
    if (path.endsWith("/preview"))
      return Response.json(
        await magic.inspect(
          input.confirmationId,
          nonce,
          await runtime.identity.authenticate(session),
        ),
      );
    const result = await magic.consume(
      input.confirmationId,
      nonce,
      session,
      browserSessionContext(request, address),
    );
    return setCloudCredentials(
      Response.json({ redirect: result.redirect }),
      result.sessionToken,
      result.csrfToken,
      12 * 60 * 60,
    );
  }
  throw new CloudError(404, "not_found", "Sign-in action is unavailable.");
}

export async function handleEmailSettingsApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const service = runtime.authentication.emailSettings;
  if (request.method === "GET" && path === "/api/v1/email-settings")
    return Response.json(await service.get(actor));
  if (request.method === "PATCH" && path === "/api/v1/email-settings") {
    const key = cloudId.parse(request.headers.get("idempotency-key"));
    return Response.json(
      await service.save(
        actor,
        key,
        await readBody(request, emailSettingsInputSchema),
      ),
    );
  }
  if (request.method === "POST" && path === "/api/v1/email-settings/verify") {
    const input = await readBody(request, emailConnectionCheckSchema);
    const connection = await service.connection(actor, input.revision);
    if (
      activeConnectionChecks.size >= 2 ||
      activeConnectionChecks.has(actor.organizationId)
    )
      throw new CloudError(
        429,
        "email_check_busy",
        "An email connection check is already running. Try again shortly.",
      );
    activeConnectionChecks.add(actor.organizationId);
    try {
      await verifySmtpConnection(connection, request.signal);
    } catch (error) {
      if (!(error instanceof MailDeliveryError)) throw error;
      const messages = {
        authentication:
          "The email server rejected the credentials. Check the username and password.",
        connection:
          "The email server could not be reached securely. Check the host, port and TLS settings.",
        timeout:
          "The email connection timed out. Check the server and try again.",
        recipient:
          "The email server rejected the address. Check the sender address.",
        failed:
          "The email connection failed. Check the settings and try again.",
      };
      throw new CloudError(
        422,
        "email_connection_failed",
        messages[error.code],
      );
    } finally {
      activeConnectionChecks.delete(actor.organizationId);
    }
    const current = await service.get(actor);
    checkRevision(current.settings?.revision ?? 0, input.revision);
    return Response.json({ ok: true });
  }
  throw new CloudError(404, "not_found", "Email settings are unavailable.");
}
