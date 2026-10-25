import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Provider } from "oidc-provider";

export async function oidcFixture(fixture) {
  let provider;
  let callback;
  let issuer;
  const errors = [];
  const requests = [];
  const server = createServer(
    {
      key: await readFile(join(fixture.directory, "tls.key")),
      cert: await readFile(join(fixture.directory, "tls.crt")),
    },
    (request, response) => {
      requests.push(request.url.split("?")[0]);
      if (!request.url.startsWith("/interaction/"))
        return callback(request, response);
      void (async () => {
        const interaction = await provider.interactionDetails(
          request,
          response,
        );
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "GET") {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            `<html><body><h1>${interaction.prompt.name === "login" ? "Provider sign-in" : "Provider consent"}</h1><form method="post"><label>Subject <input name="subject" value="owner-subject"></label><button>Continue</button></form></body></html>`,
          );
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 2048) throw new Error("Body limit");
        }
        if (interaction.prompt.name === "login") {
          const subject = new URLSearchParams(body).get("subject");
          if (!subject || subject.length > 255)
            throw new Error("Invalid subject");
          await provider.interactionFinished(
            request,
            response,
            { login: { accountId: subject } },
            { mergeWithLastSubmission: false },
          );
        } else if (interaction.prompt.name === "consent") {
          const grant = interaction.grantId
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({
                accountId: interaction.session.accountId,
                clientId: interaction.params.client_id,
              });
          if (interaction.prompt.details.missingOIDCScope)
            grant.addOIDCScope(
              interaction.prompt.details.missingOIDCScope.join(" "),
            );
          if (interaction.prompt.details.missingOIDCClaims)
            grant.addOIDCClaims(interaction.prompt.details.missingOIDCClaims);
          const grantId = await grant.save();
          await provider.interactionFinished(
            request,
            response,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
        } else throw new Error("Unexpected interaction");
      })().catch((error) => {
        errors.push(error.message);
        response.statusCode = 500;
        response.end("Fixture failed");
      });
    },
  );
  await new Promise((done) => server.listen(0, "localhost", done));
  issuer = `https://localhost:${server.address().port}`;
  const secret = randomBytes(32).toString("base64url");
  function configure() {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    provider = new Provider(issuer, {
      clients: [
        {
          client_id: "cloud-fixture",
          client_secret: secret,
          redirect_uris: [`${fixture.origin}/api/v1/auth/sso/callback`],
          response_types: ["code"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "client_secret_basic",
          id_token_signed_response_alg: "RS256",
        },
      ],
      jwks: {
        keys: [
          {
            ...privateKey.export({ format: "jwk" }),
            kid: randomBytes(12).toString("hex"),
            use: "sig",
            alg: "RS256",
          },
        ],
      },
      cookies: { keys: [randomBytes(32).toString("base64url")] },
      features: { devInteractions: { enabled: false } },
      interactions: {
        url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      },
      claims: {
        openid: ["sub"],
        email: ["email", "email_verified"],
        profile: ["name"],
      },
      findAccount: async (_ctx, accountId) => ({
        accountId,
        claims: async () => ({
          sub: accountId,
          email: "owner@example.test",
          email_verified: true,
          name: "Fixture identity",
        }),
      }),
    });
    provider.on("server_error", (_ctx, error) => errors.push(error.message));
    callback = provider.callback();
  }
  configure();
  return {
    issuer,
    secret,
    errors,
    requests,
    rotate: configure,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
