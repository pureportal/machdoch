import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor, CloudRole } from "../../../lib/cloud-contract";
import {
  providerInputSchema,
  providerUpdateSchema,
  type ProviderInput,
} from "@machdoch/fleet-protocol/cloud-providers";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { cloudCredentialsCipher } from "../credential-storage";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let outsider: CloudActor;
const key = randomBytes(32);
const secret = "provider-test-secret-should-never-be-returned";
const configuration: ProviderInput = {
  name: "Primary",
  provider: "openai",
  region: null,
  models: ["gpt-5.5"],
  maxOutputTokens: 4096,
  dailyTokenBudget: 200000,
  maxConcurrentRequests: 4,
  apiKey: secret,
};
beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(key),
  });
}, 30_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID();
  const otherId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'First'),($2,'Second')",
    [organizationId, otherId],
  );
  async function add(organization: string, role: CloudRole) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${userId}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organization, userId, role],
    );
    return { organizationId: organization, userId };
  }
  owner = await add(organizationId, "owner");
  member = await add(organizationId, "member");
  viewer = await add(organizationId, "viewer");
  outsider = await add(otherId, "owner");
});

it("encrypts credentials and omits them from metadata, receipts and events", async () => {
  const commandId = randomUUID();
  const created = await runtime.aiProviders.create(
    owner,
    commandId,
    configuration,
  );
  expect(
    await runtime.aiProviders.create(owner, commandId, configuration),
  ).toEqual(created);
  const metadata = await runtime.aiProviders.list(owner, true);
  expect(metadata.providers).toHaveLength(1);
  expect(JSON.stringify(metadata)).not.toContain(secret);
  expect(metadata.providers[0]).not.toHaveProperty("secret");
  const stored = (
    await database.engine.query<{ secret: Uint8Array }>(
      "SELECT secret FROM cloud_ai_providers",
    )
  ).rows[0]!;
  expect(Buffer.from(stored.secret).includes(Buffer.from(secret))).toBe(false);
  expect(
    JSON.stringify(
      (await database.engine.query("SELECT result FROM cloud_command_receipts"))
        .rows,
    ),
  ).not.toContain(secret);
  expect(
    JSON.stringify(
      (await database.engine.query("SELECT payload FROM cloud_outbox")).rows,
    ),
  ).not.toContain(secret);
  expect(
    (await runtime.aiProviders.resolve(member, created.id, "gpt-5.5"))
      .connection.apiKey,
  ).toBe(secret);
});

it("requires administrator rights for configuration and current model and membership rights for use", async () => {
  await expect(
    runtime.aiProviders.create(member, randomUUID(), configuration),
  ).rejects.toMatchObject({ status: 403 });
  await expect(runtime.aiProviders.list(viewer, true)).rejects.toMatchObject({
    status: 403,
  });
  const created = await runtime.aiProviders.create(
    owner,
    randomUUID(),
    configuration,
  );
  expect((await runtime.aiProviders.list(outsider)).providers).toEqual([]);
  await expect(
    runtime.aiProviders.resolve(outsider, created.id, "gpt-5.5"),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.aiProviders.resolve(viewer, created.id, "gpt-5.5"),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    runtime.aiProviders.resolve(member, created.id, "unconfigured-model"),
  ).rejects.toMatchObject({ code: "model_unavailable" });
  await runtime.administration.updateMember(
    owner,
    randomUUID(),
    member.userId,
    { revision: 1, role: "member", active: false },
  );
  await expect(
    runtime.aiProviders.resolve(member, created.id, "gpt-5.5"),
  ).rejects.toMatchObject({ status: 403 });
});

it("preserves the key on ordinary edits, rotates it explicitly, rejects stale saves and disables usage", async () => {
  const created = await runtime.aiProviders.create(
    owner,
    randomUUID(),
    configuration,
  );
  const metadata = (await runtime.aiProviders.list(owner, true)).providers[0]!;
  const update = providerUpdateSchema
    .strip()
    .parse({ ...metadata, name: "Renamed" });
  await runtime.aiProviders.update(owner, randomUUID(), created.id, update);
  expect(
    (await runtime.aiProviders.resolve(member, created.id, "gpt-5.5"))
      .connection.apiKey,
  ).toBe(secret);
  await expect(
    runtime.aiProviders.update(owner, randomUUID(), created.id, update),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await runtime.aiProviders.update(
    owner,
    randomUUID(),
    created.id.toUpperCase(),
    {
      ...update,
      revision: 2,
      apiKey: "replacement-test-key",
    },
  );
  expect(
    (await runtime.aiProviders.resolve(member, created.id, "gpt-5.5"))
      .connection.apiKey,
  ).toBe("replacement-test-key");
  await runtime.aiProviders.update(owner, randomUUID(), created.id, {
    ...update,
    revision: 3,
    enabled: false,
  });
  expect((await runtime.aiProviders.list(member)).providers).toHaveLength(0);
  expect((await runtime.aiProviders.list(owner, true)).providers).toHaveLength(
    1,
  );
  await expect(
    runtime.aiProviders.resolve(member, created.id, "gpt-5.5"),
  ).rejects.toMatchObject({ status: 404 });
});

it("rejects missing or changed storage keys and ciphertext swapped between connections", async () => {
  const unavailable = createCloudRuntime(database, runtime.origin);
  expect(
    (await unavailable.aiProviders.list(owner, true))
      .credentialStorageAvailable,
  ).toBe(false);
  await expect(
    unavailable.aiProviders.create(owner, randomUUID(), configuration),
  ).rejects.toMatchObject({ code: "credential_storage" });
  const first = await runtime.aiProviders.create(
    owner,
    randomUUID(),
    configuration,
  );
  const second = await runtime.aiProviders.create(owner, randomUUID(), {
    ...configuration,
    name: "Second",
  });
  const wrong = createCloudRuntime(database, runtime.origin, {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
  });
  await expect(
    wrong.aiProviders.create(owner, randomUUID(), {
      ...configuration,
      name: "Wrong key",
    }),
  ).rejects.toMatchObject({ code: "credential_storage" });
  await expect(
    wrong.aiProviders.resolve(owner, first.id, "gpt-5.5"),
  ).rejects.toMatchObject({ code: "credential_storage" });
  await database.engine.query(
    "UPDATE cloud_ai_providers SET secret=(SELECT secret FROM cloud_ai_providers WHERE id=$1) WHERE id=$2",
    [first.id, second.id],
  );
  await expect(
    runtime.aiProviders.resolve(owner, second.id, "gpt-5.5"),
  ).rejects.toMatchObject({ code: "credential_storage" });
});

it("validates model identifiers, provider regions and explicit storage key encoding", () => {
  expect(
    providerInputSchema.safeParse({
      ...configuration,
      models: ["https://example.test/model"],
    }).success,
  ).toBe(false);
  expect(
    providerInputSchema.safeParse({
      ...configuration,
      models: ["models/../admin"],
    }).success,
  ).toBe(false);
  expect(
    providerInputSchema.safeParse({ ...configuration, region: "eu" }).success,
  ).toBe(false);
  expect(
    providerInputSchema.safeParse({
      ...configuration,
      provider: "langdock",
      region: "eu",
    }).success,
  ).toBe(true);
  expect(cloudCredentialsCipher(undefined)).toBeNull();
  expect(() => cloudCredentialsCipher("incorrect")).toThrow();
  expect(cloudCredentialsCipher(key.toString("base64url"))).toBeInstanceOf(
    SettingsCipher,
  );
});
