import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { runOidcJob } from "../src/server/cloud/auth/oidc.ts";
import { hashSecret } from "../src/server/crypto.ts";
import {
  cloudBrowserFixture,
  cloudApi,
  assertEventually,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-email-fixture.ts",
});
const checks = [];
const priorAuthorities = getCACertificates("default");
const servers = [];
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function endpoint(mode) {
  let requested = 0,
    redirected = 0,
    closed = 0;
  const server = createServer(
    {
      key: await readFile(join(fixture.directory, "tls.key")),
      cert: await readFile(join(fixture.directory, "tls.crt")),
    },
    (request, response) => {
      requested++;
      request.socket.once("close", () => closed++);
      if (request.url === "/redirected") {
        redirected++;
        response.end("{}");
      } else if (mode === "redirect") {
        response.writeHead(302, { Location: `${origin}/redirected` });
        response.end();
      } else if (mode === "large") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("x".repeat(300000));
      } else if (mode === "valid") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            issuer: origin,
            authorization_endpoint: `${origin}/auth`,
            token_endpoint: `${origin}/token`,
            jwks_uri: `${origin}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      }
    },
  );
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, counts: () => ({ requested, redirected, closed }) };
}
async function post(context, path, data, explicitCookies) {
  const cookies = explicitCookies ?? (await context.cookies());
  const csrf =
    cookies.find((cookie) => cookie.name === "__Host-machdoch_cloud_csrf")
      ?.value ?? "";
  return context.request.post(`${fixture.origin}/api/v1/${path}`, {
    headers: {
      Origin: fixture.origin,
      "x-machdoch-cloud-csrf": csrf,
      Cookie: cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; "),
    },
    data,
  });
}
async function login(context, email = "owner@example.test") {
  const response = await post(context, "auth/login", {
    email,
    password: fixture.password,
  });
  assert.equal(response.status(), 200, await response.text());
}
try {
  const valid = await endpoint("valid");
  await assert.rejects(
    runOidcJob("untrusted", { kind: "discover", issuer: valid.origin }),
    (error) => error.code === "sso_provider_failed",
  );
  setDefaultCACertificates([
    ...priorAuthorities,
    await readFile(join(fixture.directory, "tls.crt"), "utf8"),
  ]);
  assert.equal(
    (await runOidcJob("valid", { kind: "discover", issuer: valid.origin }))
      .issuer,
    valid.origin,
  );
  for (const mode of ["redirect", "large"]) {
    const value = await endpoint(mode);
    await assert.rejects(
      runOidcJob(mode, { kind: "discover", issuer: value.origin }),
      (error) => error.code === "sso_provider_failed",
    );
    assert.equal(value.counts().redirected, 0);
  }
  passed(
    "Requires trusted TLS, rejects redirected discovery without following it, and bounds provider response bytes",
  );
  const stalled = await endpoint("stalled");
  const controller = new AbortController();
  const work = runOidcJob(
    "stalled",
    { kind: "discover", issuer: stalled.origin },
    controller.signal,
  );
  const stopped = assert.rejects(
    work,
    (error) => error.code === "sso_provider_failed",
  );
  await assertEventually(() => stalled.counts().requested === 1);
  await assert.rejects(
    runOidcJob("stalled", { kind: "discover", issuer: valid.origin }),
    (error) => error.code === "sso_busy",
  );
  controller.abort();
  await stopped;
  await assertEventually(() => stalled.counts().closed === 1);
  assert.equal(
    (await runOidcJob("stalled", { kind: "discover", issuer: valid.origin }))
      .issuer,
    valid.origin,
  );
  passed(
    "Rejects concurrent discovery, terminates a canceled worker and its socket, and releases capacity for another request",
  );

  await login(fixture.ownerContext);
  const providerId = randomUUID();
  const configuration = {
    revision: 0,
    name: "Race provider",
    enabled: true,
    clientId: "client",
    secret: "fixture-secret",
    authentication: "client_secret_basic",
    algorithm: "RS256",
    displaySource: "id_token",
    displayClaim: "sub",
    requiredAcr: null,
    maxAge: null,
    metadata: {
      issuer: valid.origin,
      authorization_endpoint: `${valid.origin}/auth`,
      token_endpoint: `${valid.origin}/token`,
      jwks_uri: `${valid.origin}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
  };
  await cloudApi(
    fixture,
    fixture.ownerContext,
    `sso-providers/${providerId}`,
    "PATCH",
    configuration,
  );
  const organizationId = (
    await fixture.database.query("SELECT id FROM cloud_organizations")
  ).rows[0].id;
  for (const race of ["duplicate", "logout", "password"]) {
    const userId = randomUUID(),
      email = `${race}@example.test`,
      subject = `${race}-subject`;
    await fixture.database.query(
      "INSERT INTO cloud_users(id,email,name,password_hash) SELECT $1,$2,'Race member',password_hash FROM cloud_users WHERE email='owner@example.test'",
      [userId, email],
    );
    await fixture.database.query(
      "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
      [organizationId, userId],
    );
    const context = await fixture.createContext();
    await login(context, email);
    const start = await cloudApi(fixture, context, "sso-link", "POST", {
      providerId,
    });
    const state = new URL(start.url).searchParams.get("state");
    const flowId = (
      await fixture.database.query(
        "UPDATE cloud_sso_flows SET status='verified',proof=NULL,claims=$2 WHERE state_hash=$1 RETURNING id",
        [
          hashSecret(state),
          JSON.stringify({
            subject,
            display: email,
            authTime: null,
            acr: null,
          }),
        ],
      )
    ).rows[0].id;
    await cloudApi(fixture, context, "auth/sso/preview", "POST", {
      id: flowId,
    });
    const cookies = await context.cookies();
    const started = Date.now();
    const responses = await Promise.all([
      post(context, "auth/sso/consume", { id: flowId }, cookies),
      race === "duplicate"
        ? post(context, "auth/sso/consume", { id: flowId }, cookies)
        : race === "logout"
          ? post(context, "auth/logout", {}, cookies)
          : post(
              context,
              "auth/login",
              { email, password: fixture.password },
              cookies,
            ),
    ]);
    const statuses = responses.map((response) => response.status());
    assert.ok(
      statuses.every((status) => [200, 403, 410].includes(status)),
      `${race}: ${statuses.join(",")} ${fixture.logs()}`,
    );
    assert.ok(Date.now() - started < 5000, `Lock wait in ${race}`);
    const mappings = (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sso_mappings WHERE user_id=$1",
        [userId],
      )
    ).rows[0].count;
    if (race === "duplicate") {
      assert.deepEqual(statuses, [200, 200]);
      assert.equal(mappings, 1);
      assert.equal(
        (
          await fixture.database.query(
            "SELECT count(*)::int AS count FROM cloud_sessions WHERE user_id=$1 AND authentication_method='oidc'",
            [userId],
          )
        ).rows[0].count,
        1,
      );
    }
    if (race === "logout") {
      assert.equal(
        (
          await fixture.database.query(
            "SELECT count(*)::int AS count FROM cloud_sessions WHERE user_id=$1",
            [userId],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await fixture.database.query(
            "SELECT count(*)::int AS count FROM cloud_sso_flows WHERE id=$1",
            [flowId],
          )
        ).rows[0].count,
        0,
      );
    }
    await context.close();
  }
  passed(
    "Concurrent confirmations create one mapping/session; logout and password sign-in races finish without deadlock or resurrecting logged-out authority",
  );

  await fixture.database.query(
    "INSERT INTO cloud_signin_policies(organization_id,required_sso) VALUES($1,true)",
    [organizationId],
  );
  await fixture.database.query(
    "UPDATE cloud_sso_providers SET enabled=false,authentication_epoch=nextval('cloud_authentication_generation') WHERE id=$1",
    [providerId],
  );
  assert.equal(
    (
      await post(fixture.ownerContext, "auth/login", {
        email: "owner@example.test",
        password: fixture.password,
      })
    ).status(),
    403,
  );
  const recovery = spawn(
    process.execPath,
    ["--import", "@oxc-node/core/register", "scripts/cloud-recover-signin.ts"],
    {
      cwd: new URL("..", import.meta.url),
      windowsHide: true,
      env: {
        ...process.env,
        MACHDOCH_CLOUD_DATABASE_URL: fixture.database.options.connectionString,
        MACHDOCH_CLOUD_RECOVERY_ORGANIZATION_ID: organizationId,
        MACHDOCH_CLOUD_OWNER_EMAIL: "owner@example.test",
        MACHDOCH_CLOUD_OWNER_PASSWORD: fixture.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  recovery.stdout.on("data", (value) => (output += value));
  recovery.stderr.on("data", (value) => (output += value));
  assert.equal(
    await new Promise((done, reject) => {
      recovery.once("exit", done);
      recovery.once("error", reject);
    }),
    0,
    output,
  );
  await login(fixture.ownerContext);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT action FROM cloud_operator_audit WHERE organization_id=$1",
        [organizationId],
      )
    ).rows[0].action,
    "signin.recovered",
  );
  assert.equal(
    (await cloudApi(fixture, fixture.ownerContext, "sso-policy")).required,
    false,
  );
  passed(
    "The server operator recovers an owner after a total SSO outage, invalidates old authority and writes a separate operator audit record",
  );
  await writeFile(
    join(fixture.directory, "sso-resilience-results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  console.log(`Evidence: ${fixture.directory}`);
} catch (error) {
  await writeFile(
    join(fixture.directory, "sso-resilience-failure.json"),
    JSON.stringify(
      { checks, error: error.stack, logs: fixture.logs() },
      null,
      2,
    ),
  );
  throw error;
} finally {
  setDefaultCACertificates(priorAuthorities);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await fixture.close();
}
