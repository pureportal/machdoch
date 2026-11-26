import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import {
  gitHubAppJwt,
  gitHubAppName,
  gitHubAppPermissions,
} from "./github-app";

const apiUrl = "https://api.github.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const installationToken = (index: number) =>
  `ghs_${String(index).padStart(36, "0")}`;

interface Call {
  method: string;
  path: string;
  authorization: string | null;
}

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let calls: Call[];
let issuedTokens: number;
let tokenFailure: number | null;
let installedRepositories: number;

function claims(authorization: string | null) {
  const [header, payload, signature] = (authorization ?? "")
    .replace(/^Bearer /u, "")
    .split(".");
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature ?? "", "base64url"),
  );
  return {
    valid,
    ...(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as {
      iss: string;
      iat: number;
      exp: number;
    }),
  };
}

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const authorization = new Headers(init?.headers).get("authorization");
  calls.push({ method, path: url.pathname, authorization });
  if (method === "POST" && url.pathname === "/app-manifests/code-1/conversions")
    return Response.json(
      {
        id: 4242,
        slug: "machdoch-acme",
        client_id: "Iv1.acme",
        client_secret: "client-secret",
        webhook_secret: "webhook-secret",
        pem: privateKey,
      },
      { status: 201 },
    );
  if (method === "GET" && url.pathname === "/app/installations/77")
    return Response.json({ account: { login: "acme" } });
  if (
    method === "POST" &&
    url.pathname === "/app/installations/77/access_tokens"
  ) {
    if (tokenFailure)
      return Response.json(
        { message: "Bad credentials" },
        { status: tokenFailure },
      );
    issuedTokens += 1;
    return Response.json(
      {
        token: installationToken(issuedTokens),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { status: 201 },
    );
  }
  if (method === "DELETE" && url.pathname === "/app/installations/77")
    return new Response(null, { status: 204 });
  if (method === "GET" && url.pathname === "/installation/repositories") {
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("per_page"));
    const start = (page - 1) * size;
    const count = Math.max(0, Math.min(size, installedRepositories - start));
    return Response.json({
      total_count: installedRepositories,
      repositories: Array.from({ length: count }, (_, index) => ({
        full_name: `acme/repo-${start + index}`,
        private: true,
      })),
    });
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}) as typeof fetch;

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  calls = [];
  issuedTokens = 0;
  tokenFailure = null;
  installedRepositories = 2;
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    gitFetch: transport,
  });
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID();
  owner = { organizationId, userId: randomUUID() };
  member = { organizationId, userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Acme Corp')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
});

async function install() {
  const { url } = await runtime.git.apps.start(owner, {
    apiUrl,
    owner: "acme",
  });
  const state = new URL(url).searchParams.get("state")!;
  const registration = await runtime.git.apps.registration(state);
  const installUrl = await runtime.git.apps.created("code-1", state);
  const repeatedInstallUrl = await runtime.git.apps.created("code-1", state);
  const id = await runtime.git.apps.installed(77, state);
  return { url, state, registration, installUrl, repeatedInstallUrl, id };
}

it("signs short-lived app tokens with the app key", () => {
  const now = Date.UTC(2026, 0, 1);
  const token = gitHubAppJwt({ appId: 4242, privateKey }, now);
  expect(claims(`Bearer ${token}`)).toEqual({
    valid: true,
    iss: "4242",
    iat: now / 1000 - 60,
    exp: now / 1000 - 60 + 540,
  });
});

it("names the app after the workspace within GitHub's limit", () => {
  expect(gitHubAppName("Acme Corp")).toBe("Machdoch Acme Corp");
  expect(gitHubAppName("Ünïcode & Co. ✓")).toBe("Machdoch ncode  Co.");
  expect(gitHubAppName("x".repeat(60))).toHaveLength(34);
});

it("creates and installs a GitHub App as the workspace connection", async () => {
  const { url, state, registration, installUrl, repeatedInstallUrl, id } =
    await install();
  expect(url).toMatch(
    /^https:\/\/cloud\.example\.test\/api\/v1\/integrations\/github\/app\/start\?state=/u,
  );
  expect(registration.action).toBe(
    `https://github.com/organizations/acme/settings/apps/new?state=${state}`,
  );
  const manifest = JSON.parse(registration.manifest) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    name: "Machdoch Acme Corp",
    url: "https://cloud.example.test",
    public: false,
    redirect_url:
      "https://cloud.example.test/api/v1/integrations/github/app/created",
    setup_url:
      "https://cloud.example.test/api/v1/integrations/github/app/installed",
    hook_attributes: {
      url: expect.stringMatching(
        /^https:\/\/cloud\.example\.test\/api\/v1\/integrations\/github\/webhooks\//u,
      ),
      active: true,
    },
    default_permissions: gitHubAppPermissions,
  });
  expect(manifest.default_permissions).toMatchObject({
    administration: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
  });
  expect(installUrl).toBe(
    `https://github.com/apps/machdoch-acme/installations/new?state=${state}`,
  );
  expect(repeatedInstallUrl).toBe(installUrl);
  expect(
    calls.filter((call) => call.path.startsWith("/app-manifests/")),
  ).toHaveLength(1);

  const appCalls = calls.filter((call) => call.path.startsWith("/app/"));
  expect(appCalls.map((call) => [call.method, call.path])).toEqual([
    ["GET", "/app/installations/77"],
    ["POST", "/app/installations/77/access_tokens"],
  ]);
  for (const call of appCalls)
    expect(claims(call.authorization)).toMatchObject({
      valid: true,
      iss: "4242",
    });

  const connection = (
    await runtime.git.connections.get(owner)
  ).connections.find((entry) => entry.id === id);
  expect(connection).toMatchObject({
    provider: "github",
    account: "acme",
    app: {
      slug: "machdoch-acme",
      configureUrl: "https://github.com/apps/machdoch-acme/installations/new",
    },
  });
  await expect(runtime.git.apps.installed(77, state)).rejects.toMatchObject({
    code: "git_app_setup",
  });
  await expect(
    runtime.git.connections.connect(owner, randomUUID(), "github", {
      connectionId: id,
      revision: connection!.revision,
      apiUrl,
      token: `github_pat_${"a".repeat(40)}`,
      automate: true,
      codeAccess: true,
    }),
  ).rejects.toMatchObject({ code: "git_app_managed" });
});

it("lists every installed repository across pages", async () => {
  const { id } = await install();
  installedRepositories = 230;
  const repositories = await runtime.git.connections.available(owner, id);
  expect(repositories).toHaveLength(230);
  expect(repositories.at(-1)).toEqual({
    fullName: "acme/repo-229",
    private: true,
  });
  const listed = calls.filter(
    (call) => call.path === "/installation/repositories",
  );
  expect(listed).toHaveLength(3);
  for (const call of listed)
    expect(call.authorization).toBe(`Bearer ${installationToken(1)}`);
});

it("refreshes installation tokens before they expire and reports failures", async () => {
  const { id } = await install();
  expect(await runtime.git.apps.refreshTokens()).toBe(0);
  const due = () =>
    database.engine.query(
      "UPDATE cloud_git_connections SET token_refresh_at=clock_timestamp() - interval '1 minute' WHERE id=$1",
      [id],
    );
  const stored = async () =>
    (
      await database.engine.query<{
        token_prefix: string;
        last_error: string | null;
        refresh_minutes: number;
      }>(
        "SELECT token_prefix,last_error,extract(epoch FROM token_refresh_at - clock_timestamp())/60 AS refresh_minutes FROM cloud_git_connections WHERE id=$1",
        [id],
      )
    ).rows[0]!;

  await due();
  tokenFailure = 401;
  expect(await runtime.git.apps.refreshTokens()).toBe(1);
  const failed = await stored();
  expect(failed.last_error).toMatch(/^GitHub App: /u);
  expect(Number(failed.refresh_minutes)).toBeGreaterThan(4);
  expect(Number(failed.refresh_minutes)).toBeLessThanOrEqual(5);
  expect(await runtime.git.apps.refreshTokens()).toBe(0);

  await due();
  tokenFailure = null;
  expect(await runtime.git.apps.refreshTokens()).toBe(1);
  const refreshed = await stored();
  expect(refreshed.last_error).toBeNull();
  expect(refreshed.token_prefix).toBe(installationToken(2).slice(0, 12));
  expect(Number(refreshed.refresh_minutes)).toBeGreaterThan(40);
  installedRepositories = 1;
  await runtime.git.connections.available(owner, id);
  expect(calls.at(-1)?.authorization).toBe(`Bearer ${installationToken(2)}`);
});

it("lets only Git managers start the setup and uninstalls the app on disconnect", async () => {
  await expect(
    runtime.git.apps.start(member, { apiUrl, owner: null }),
  ).rejects.toMatchObject({ status: 403 });
  const { url } = await runtime.git.apps.start(owner, { apiUrl, owner: null });
  expect(
    (
      await runtime.git.apps.registration(
        new URL(url).searchParams.get("state")!,
      )
    ).action,
  ).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/u);
  await expect(runtime.git.apps.registration("unknown")).rejects.toMatchObject({
    code: "git_app_setup",
  });

  const { id } = await install();
  const revision = (await runtime.git.connections.get(owner)).connections.find(
    (entry) => entry.id === id,
  )!.revision;
  await runtime.git.connections.disconnect(owner, id, revision);
  expect(
    calls.filter(
      (call) =>
        call.method === "DELETE" && call.path === "/app/installations/77",
    ),
  ).toHaveLength(1);
  expect((await runtime.git.connections.get(owner)).connections).toEqual([]);
});
