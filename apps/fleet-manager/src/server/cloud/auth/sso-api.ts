import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hashSecret } from "../../crypto";
import { cloudId, type CloudActor } from "../../../lib/cloud-contract";
import {
  oidcDiscoverySchema,
  oidcMappingSchema,
  oidcSaveSchema,
  ssoMemberSchema,
} from "../../../lib/cloud-sso-contract";
import { cookieValue } from "../../request-auth";
import { CloudError, isCloudError } from "../access";
import { requireCloudOrigin, setCloudCredentials } from "../browser-auth";
import { cloudSessionCookie } from "../identity";
import { readBody } from "../request-body";
import type { CloudRuntime } from "../runtime";
import { ssoBrowserCookie, setProofCookie } from "./proof-cookies";
import { browserSessionContext } from "./session-context";

const startSchema = z.strictObject({
  providerId: cloudId,
  authorizationId: cloudId.optional(),
});
const confirmationSchema = z.strictObject({ id: cloudId });
const policySchema = z.strictObject({
  required: z.boolean(),
  revision: z.number().int().min(0),
});

export async function handleSsoApi(
  runtime: CloudRuntime,
  request: Request,
  address: string,
): Promise<Response> {
  const url = new URL(request.url);
  const flows = runtime.authentication.ssoFlows;
  const browser = cookieValue(request, ssoBrowserCookie) ?? "";
  const session = cookieValue(request, cloudSessionCookie) ?? "";
  if (request.method === "GET" && url.pathname.endsWith("/callback")) {
    try {
      const result = await runtime.authentication.oidcExchange.callback(
        url.search,
        browser,
      );
      return new Response(null, {
        status: 303,
        headers: {
          Location: result.confirmationId
            ? `${runtime.origin}/cloud/join?confirmation=${result.confirmationId}`
            : result.failed
              ? `${runtime.origin}/cloud/sso?failed=1`
              : `${runtime.origin}/cloud/sso?id=${result.id}`,
        },
      });
    } catch (error) {
      if (!isCloudError(error))
        console.error(
          "SSO callback failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      return new Response(null, {
        status: 303,
        headers: { Location: `${runtime.origin}/cloud/sso?failed=1` },
      });
    }
  }
  if (request.method !== "POST")
    throw new CloudError(
      405,
      "method_not_allowed",
      "Use the sign-in page to continue.",
    );
  requireCloudOrigin(runtime, request);
  if (url.pathname.endsWith("/start")) {
    const input = await readBody(request, startSchema);
    await runtime.identity.limitMagicProof(
      address,
      `sso-start:${hashSecret(browser || randomUUID())}`,
    );
    const result = await flows.begin(
      input.providerId,
      "login",
      browser,
      session,
      undefined,
      input.authorizationId,
    );
    return setProofCookie(
      Response.json({ url: result.url }),
      "sso",
      result.nonce,
    );
  }
  const { id } = await readBody(request, confirmationSchema);
  await runtime.identity.limitMagicProof(address, id);
  if (url.pathname.endsWith("/preview"))
    return Response.json(await flows.preview(id, browser, session));
  if (url.pathname.endsWith("/consume")) {
    const result = await flows.consume(
      id,
      browser,
      session,
      browserSessionContext(request, address),
    );
    return setCloudCredentials(
      Response.json({ redirect: result.redirect }),
      result.sessionToken,
      result.csrfToken,
      12 * 3600,
    );
  }
  throw new CloudError(404, "not_found", "Sign-in action is unavailable.");
}

export async function handleSsoSettingsApi(
  runtime: CloudRuntime,
  request: Request,
  actor: CloudActor,
): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").slice(3);
  const providers = runtime.authentication.ssoProviders;
  if (parts[0] === "sso-policy") {
    if (request.method === "GET")
      return Response.json(
        await runtime.authentication.signinPolicy.get(actor),
      );
    if (request.method === "PATCH")
      return Response.json(
        await runtime.authentication.signinPolicy.save(
          actor,
          cloudId.parse(request.headers.get("idempotency-key")),
          await readBody(request, policySchema),
          cookieValue(request, cloudSessionCookie) ?? "",
        ),
      );
  }
  if (parts[0] === "sso-link" && request.method === "POST") {
    const { providerId } = await readBody(
      request,
      z.strictObject({ providerId: cloudId }),
    );
    const result = await runtime.authentication.ssoFlows.begin(
      providerId,
      "link",
      cookieValue(request, ssoBrowserCookie) ?? "",
      cookieValue(request, cloudSessionCookie) ?? "",
      actor,
    );
    return setProofCookie(
      Response.json({ url: result.url }),
      "sso",
      result.nonce,
    );
  }
  if (parts.length === 1 && request.method === "GET")
    return Response.json(await providers.get(actor));
  if (parts[1] === "discover" && request.method === "POST") {
    const { issuer } = await readBody(request, oidcDiscoverySchema);
    return Response.json(
      await providers.discover(actor, issuer, request.signal),
    );
  }
  const id = cloudId.parse(parts[1]);
  if (parts[2] === "members" && request.method === "POST")
    return Response.json(
      await providers.addMember(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        id,
        await readBody(request, ssoMemberSchema),
      ),
    );
  if (parts.length === 2 && request.method === "PATCH")
    return Response.json(
      await providers.save(
        actor,
        cloudId.parse(request.headers.get("idempotency-key")),
        id,
        await readBody(request, oidcSaveSchema),
      ),
    );
  if (parts[2] === "mappings") {
    if (request.method === "GET")
      return Response.json(await providers.mappings(actor, id));
    if (request.method === "POST") {
      const input = await readBody(request, oidcMappingSchema);
      return Response.json(
        await providers.map(
          actor,
          cloudId.parse(request.headers.get("idempotency-key")),
          id,
          input.userId,
          input.subject,
        ),
      );
    }
    if (request.method === "DELETE") {
      const input = await readBody(request, oidcMappingSchema);
      return Response.json(
        await providers.unmap(
          actor,
          cloudId.parse(request.headers.get("idempotency-key")),
          id,
          input.userId,
          input.subject,
        ),
      );
    }
  }
  throw new CloudError(404, "not_found", "SSO settings are unavailable.");
}
