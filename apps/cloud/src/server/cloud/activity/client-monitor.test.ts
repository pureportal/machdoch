import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { HostResponse, ProductSnapshot } from "@machdoch/fleet-protocol";
import type { CloudActor } from "../../../lib/cloud-contract";
import { aiActivityQuerySchema } from "../../../lib/cloud-activity-contract";
import type { FleetInstance } from "../../fleet-store";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { CloudClientMonitor, type ClientFleet } from "./client-monitor";
import { CloudMimoriiExporter } from "./mimorii-export";
import type { MimoriiLogBatch } from "./mimorii-protocol";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let clock: number;
let online: boolean;
let tasks: ProductSnapshot["sessions"];
let instance: FleetInstance;
const cipher = new SettingsCipher(randomBytes(32));
const relay = vi.fn<ClientFleet["gateways"]["relay"]>();
const fleet: ClientFleet = {
  fleetStore: { listInstances: async () => [instance] },
  gateways: { isOnline: () => online, relay },
};

function task(taskId: string, state: string, message = "") {
  return {
    taskId,
    task: "Private prompt",
    mode: "machdoch",
    state,
    message,
    cancellable: false,
    startedAt: 1,
    updatedAt: 1,
    progressCount: 0,
    logs: [],
    timeline: [],
  };
}

const feed = (actor: CloudActor) =>
  runtime.activity.feed.list(
    actor,
    aiActivityQuerySchema.parse({ filter: "clients" }),
  );

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks,cloud_client_observations",
  );
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_installation (id,organization_id,credentials_key) VALUES (1,$1,'test') ON CONFLICT (id) DO UPDATE SET organization_id=$1",
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
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: cipher,
  });
  clock = 1_800_000_000_000;
  online = true;
  tasks = [task("t1", "running")];
  instance = {
    instanceId: "instance_build_laptop",
    displayName: "Build laptop",
    productVersion: "41.1.0",
    protocolVersion: 1,
    enrolledAt: 0,
    lastSeenAt: clock / 1000,
    revokedAt: null,
  };
  relay.mockReset();
  relay.mockImplementation(
    async () =>
      ({
        type: "productSnapshot",
        snapshot: {
          enabled: true,
          serverTime: clock,
          eventId: 1,
          sessions: tasks,
          commands: [],
        },
      }) as HostResponse,
  );
});

it("turns client changes into admin-only activity once and sends them to Mimorii with the device", async () => {
  await runtime.activity.mimorii.save(owner, randomUUID(), {
    revision: 0,
    url: "https://mimorii.example.test",
    token: `mim_log_${"c".repeat(43)}`,
    enabled: true,
  });
  const monitor = new CloudClientMonitor(database, fleet, () => clock);
  expect(await monitor.tick()).toBe(0);
  clock += 10_000;
  await monitor.tick();
  expect(relay).toHaveBeenCalledTimes(1);
  clock += 30_000;
  instance.lastSeenAt = clock / 1000;
  tasks = [
    task("t1", "failed", "Provider rate limited"),
    task("t2", "running"),
  ];
  expect(await monitor.tick()).toBe(2);
  expect(relay).toHaveBeenCalledTimes(2);
  const visible = await feed(owner);
  expect(
    visible.entries.map((entry) => [entry.title, entry.status, entry.detail]),
  ).toEqual([
    ["Task started", "started", ""],
    ["Task failed", "failed", "Provider rate limited"],
  ]);
  expect(visible.entries[1]).toMatchObject({
    kind: "client",
    actorName: "Build laptop",
    client: { id: "instance_build_laptop", name: "Build laptop" },
  });
  expect((await feed(member)).entries).toEqual([]);

  online = false;
  clock += 300_000;
  const otherServer = new CloudClientMonitor(database, fleet, () => clock);
  expect(await monitor.tick()).toBe(1);
  expect(await otherServer.tick()).toBe(0);
  expect((await feed(owner)).entries[0]).toMatchObject({
    title: "Client disconnected",
    status: "warning",
  });

  const batches: MimoriiLogBatch[] = [];
  const transport = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const batch = JSON.parse(String(init?.body)) as MimoriiLogBatch;
    batches.push(batch);
    return Response.json(
      {
        accepted: batch.entries.length,
        duplicates: 0,
        rejected: 0,
        errors: [],
      },
      { status: 202 },
    );
  }) as unknown as typeof fetch;
  expect(
    await new CloudMimoriiExporter(database, cipher, transport).tick(),
  ).toBe(3);
  expect(
    batches[0]!.entries.map((entry) => [
      entry.level,
      entry.message,
      entry.labels,
    ]),
  ).toEqual([
    [
      "error",
      "Task failed · Build laptop · Provider rate limited",
      { activity: "client", device: "Build laptop" },
    ],
    [
      "info",
      "Task started · Build laptop",
      { activity: "client", device: "Build laptop" },
    ],
    [
      "warn",
      "Client disconnected · Build laptop",
      { activity: "client", device: "Build laptop" },
    ],
  ]);
  expect(batches[0]!.entries[0]!.attributes).toMatchObject({
    instance_id: "instance_build_laptop",
    status: "failed",
  });
  expect(JSON.stringify(batches)).not.toContain("Private prompt");
});

it("skips clients whose snapshot cannot be read and keeps monitoring", async () => {
  relay.mockResolvedValue({
    type: "error",
    code: "unavailable",
    message: "Host stopping",
  } as HostResponse);
  const monitor = new CloudClientMonitor(database, fleet, () => clock);
  expect(await monitor.tick()).toBe(0);
  const observation = await database.engine.query<{ state: unknown }>(
    "SELECT state FROM cloud_client_observations WHERE instance_id=$1",
    [instance.instanceId],
  );
  expect(observation.rows).toEqual([{ state: null }]);
});
