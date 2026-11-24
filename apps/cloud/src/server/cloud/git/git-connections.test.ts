import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { repositoryAuthorization } from "./repository-access";
import { FakeGitServer, githubApiUrl } from "./test-git-server";

const cipher = new SettingsCipher(randomBytes(32));
const appToken = `github_pat_${"a".repeat(40)}`;
const webToken = `github_pat_${"b".repeat(40)}`;
const rotatedWebToken = `github_pat_${"c".repeat(40)}`;
const appUrl = "https://github.test/acme/app";
const webUrl = "https://github.test/acme/web";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let admin: CloudActor;

function withWebRepository(transport: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/web")
      return Response.json({
        id: 8,
        full_name: "acme/web",
        private: false,
        default_branch: "main",
        html_url: webUrl,
      });
    if (url.pathname === "/repos/acme/web/hooks")
      return Response.json({ id: 100 }, { status: 201 });
    if (url.pathname.startsWith("/repos/acme/web/")) return Response.json([]);
    return transport(input, init);
  }) as typeof fetch;
}

function connect(
  actor: CloudActor,
  token: string | undefined,
  options: { connectionId?: string; revision?: number; codeAccess?: boolean },
) {
  return runtime.git.connections.connect(actor, randomUUID(), "github", {
    connectionId: options.connectionId,
    revision: options.revision ?? 0,
    apiUrl: githubApiUrl,
    token,
    automate: true,
    codeAccess: options.codeAccess ?? true,
  });
}

function authorize(url: string) {
  return database.transaction((sql) =>
    repositoryAuthorization(sql, cipher, owner.organizationId, url),
  );
}

function basic(token: string) {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  server = new FakeGitServer();
  server.logins.set(appToken, "acme-app-bot");
  server.logins.set(webToken, "acme-web-bot");
  server.logins.set(rotatedWebToken, "acme-web-bot");
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  admin = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role, name] of [
    [owner, "owner", "Olivia"],
    [admin, "admin", "Adam"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${role}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: cipher,
    gitFetch: withWebRepository(server.transport),
  });
});

it("keeps several connections per provider apart, each with its own repositories, owner and code access", async () => {
  const app = await connect(owner, appToken, {});
  const web = await connect(admin, webToken, {});
  expect(app.id).not.toBe(web.id);
  await runtime.git.connections.addRepository(owner, app.id, "acme/app");
  await runtime.git.connections.addRepository(admin, web.id, "acme/web");

  const { connections } = await runtime.git.connections.get(owner);
  expect(connections).toHaveLength(2);
  expect(connections.find((entry) => entry.id === app.id)).toMatchObject({
    provider: "github",
    account: "acme-app-bot",
    enabledBy: "Olivia",
    codeAccess: true,
    connectedAt: expect.any(String),
    repositories: [{ fullName: "acme/app", webhook: true }],
  });
  expect(connections.find((entry) => entry.id === web.id)).toMatchObject({
    account: "acme-web-bot",
    enabledBy: "Adam",
    repositories: [{ fullName: "acme/web", webhook: true }],
  });
  expect(new Set(connections.map((entry) => entry.webhookUrl)).size).toBe(2);
  expect(await authorize(appUrl)).toBe(basic(appToken));
  expect(await authorize(webUrl)).toBe(basic(webToken));

  await expect(connect(admin, appToken, {})).rejects.toMatchObject({
    status: 409,
    code: "git_connection_exists",
  });
});

it("blocks code reads and pushes when code access is off and reconnects with a new token in place", async () => {
  const app = await connect(owner, appToken, {});
  const web = await connect(owner, webToken, {});
  await runtime.git.connections.addRepository(owner, app.id, "acme/app");
  await runtime.git.connections.addRepository(owner, web.id, "acme/web");

  const restricted = await connect(owner, undefined, {
    connectionId: app.id,
    revision: app.revision,
    codeAccess: false,
  });
  expect(restricted).toEqual({ id: app.id, revision: app.revision + 1 });
  await expect(authorize(appUrl)).rejects.toMatchObject({
    status: 409,
    code: "git_code_access",
  });
  expect(await authorize(webUrl)).toBe(basic(webToken));

  await database.engine.query(
    "UPDATE cloud_git_connections SET last_error='Bad credentials' WHERE id=$1",
    [web.id],
  );
  const before = (await runtime.git.connections.get(owner)).connections.find(
    (entry) => entry.id === web.id,
  )!;
  expect(before.lastError).toBe("Bad credentials");
  await connect(admin, rotatedWebToken, {
    connectionId: web.id,
    revision: web.revision,
  });
  const after = (await runtime.git.connections.get(owner)).connections.find(
    (entry) => entry.id === web.id,
  )!;
  expect(after).toMatchObject({
    tokenPrefix: rotatedWebToken.slice(0, 12),
    enabledBy: "Adam",
    lastError: null,
    repositories: [{ fullName: "acme/web" }],
  });
  expect(await authorize(webUrl)).toBe(basic(rotatedWebToken));
});

it("disconnects one connection and leaves the others and their repositories", async () => {
  const app = await connect(owner, appToken, {});
  const web = await connect(owner, webToken, {});
  await runtime.git.connections.addRepository(owner, app.id, "acme/app");
  await runtime.git.connections.addRepository(owner, web.id, "acme/web");

  await runtime.git.connections.disconnect(owner, app.id, app.revision);
  const { connections } = await runtime.git.connections.get(owner);
  expect(connections).toEqual([
    expect.objectContaining({
      id: web.id,
      repositories: [expect.objectContaining({ fullName: "acme/web" })],
    }),
  ]);
  expect(
    (await runtime.git.connections.repositories(owner)).map(
      (repository) => repository.fullName,
    ),
  ).toEqual(["acme/web"]);
  await expect(authorize(webUrl)).resolves.toBe(basic(webToken));
});

it("gives existing connections an id and links their repositories, deliveries, sign-ins and accounts", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("079-git-connections.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const organizationId = randomUUID();
    const userId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'a@example.test','A','test')",
      [userId],
    );
    await engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
      [organizationId, userId],
    );
    await engine.query(
      `INSERT INTO cloud_git_connections (organization_id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id,oauth_client_id,oauth_secret)
      VALUES ($1,'github',$2,'\\x00','ghp','acme',$3,'\\x00',$4,'client','\\x00')`,
      [organizationId, githubApiUrl, randomUUID(), userId],
    );
    await engine.query(
      "INSERT INTO cloud_git_repositories (organization_id,id,provider,external_id,full_name,default_branch,private) VALUES ($1,$2,'github',7,'acme/app','main',true)",
      [organizationId, randomUUID()],
    );
    await engine.query(
      "INSERT INTO cloud_git_deliveries (provider,delivery_id,organization_id,event) VALUES ('github','d-1',$1,'push')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_git_oauth_states (state_hash,organization_id,user_id,provider) VALUES ($3,$1,$2,'github')",
      [organizationId, userId, "a".repeat(64)],
    );
    await engine.query(
      `INSERT INTO cloud_git_accounts (organization_id,user_id,provider,api_url,secret,token_prefix,login,refresh_secret,expires_at)
      VALUES ($1,$2,'github',$3,'\\x00','gho','a','\\x00',now())`,
      [organizationId, userId, githubApiUrl],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const connection = (
      await engine.query<{ id: string; code_access: boolean }>(
        "SELECT id,code_access FROM cloud_git_connections",
      )
    ).rows[0]!;
    expect(connection.code_access).toBe(true);
    for (const table of [
      "cloud_git_repositories",
      "cloud_git_deliveries",
      "cloud_git_oauth_states",
    ])
      expect(
        (
          await engine.query<{ connection_id: string }>(
            `SELECT connection_id FROM ${table}`,
          )
        ).rows,
      ).toEqual([{ connection_id: connection.id }]);
    expect(
      (
        await engine.query<{ oauth_connection_id: string }>(
          "SELECT oauth_connection_id FROM cloud_git_accounts",
        )
      ).rows,
    ).toEqual([{ oauth_connection_id: connection.id }]);
    await engine.query(
      `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
      VALUES ($1,$2,'github',$3,'\\x00','ghp','acme-web',$4,'\\x00',$5)`,
      [organizationId, randomUUID(), githubApiUrl, randomUUID(), userId],
    );
    await expect(
      engine.query(
        `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
        VALUES ($1,$2,'github',$3,'\\x00','ghp','ACME',$4,'\\x00',$5)`,
        [organizationId, randomUUID(), githubApiUrl, randomUUID(), userId],
      ),
    ).rejects.toThrow();
    await engine.query(
      "DELETE FROM cloud_git_connections WHERE organization_id=$1 AND id=$2",
      [organizationId, connection.id],
    );
    expect(
      (await engine.query("SELECT 1 FROM cloud_git_repositories")).rows,
    ).toEqual([]);
    expect(
      (
        await engine.query<{ oauth_connection_id: string | null }>(
          "SELECT oauth_connection_id FROM cloud_git_accounts",
        )
      ).rows,
    ).toEqual([{ oauth_connection_id: null }]);
  } finally {
    await engine.close();
  }
}, 120_000);
