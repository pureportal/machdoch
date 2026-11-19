import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  sandboxArtifactNames,
  type SandboxRequirement,
} from "@machdoch/fleet-protocol/cloud-sandbox";
import {
  machdochDataDirectory,
  sandboxDirectory,
} from "@machdoch/cloud-client/sandbox-installation";
import {
  defaultEstimateScale,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { SettingsCipher } from "../../settings-crypto";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let profileId: string;
let directory: string;
let artifacts: Record<(typeof sandboxArtifactNames)[number], string>;
let missing: SandboxRequirement[];

beforeAll(async () => {
  database = await createTestCloudDatabase();
  directory = await mkdtemp(join(tmpdir(), "machdoch-hosted-"));
  artifacts = Object.fromEntries(
    sandboxArtifactNames.map((name) => [name, join(directory, name)]),
  ) as typeof artifacts;
  for (const name of sandboxArtifactNames)
    await writeFile(artifacts[name], `${name} artifact`);
}, 30_000);
afterAll(async () => {
  await database?.close();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  missing = [];
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 7)),
    sandboxLocation: async () => ({
      artifacts,
      cgroupRoot: process.platform === "win32" ? null : directory,
      missing,
    }),
  });
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID();
  const userId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [organizationId, userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_installation (id,organization_id,origin,credentials_key) VALUES (1,$1,'https://cloud.example.test','test')",
    [organizationId],
  );
  owner = { userId, organizationId };
  const teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  const projectId = (
    await runtime.projects.create(owner, randomUUID(), {
      teamId,
      name: "Project",
      description: "",
    })
  ).id;
  const providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["test-model"],
      apiKey: "fixture-credential",
      maxOutputTokens: 512,
      dailyTokenBudget: 100000,
      maxConcurrentRequests: 4,
    })
  ).id;
  profileId = (
    await runtime.execution.profiles.create(owner, randomUUID(), {
      projectId,
      name: "Cloud",
      target: "cloud",
      repository: "https://github.com/example/project",
      autopilot: false,
      providerId,
      model: "test-model",
      maxDurationSeconds: 3600,
      maxTokens: 10000,
      requiredChecks: [],
    })
  ).id;
});
afterEach(async () => {
  await runtime.execution.hostedRunners.close();
});

async function hostedWorkers() {
  return (await runtime.execution.workers.list(owner, profileId)).filter(
    (worker) => worker.hosted && worker.enabled,
  );
}

it("reports what the server sandbox is missing only to the installation", async () => {
  missing = ["image", "cgroup"];
  expect(await runtime.execution.sandbox.read(owner)).toEqual({
    directory: sandboxDirectory,
    missing: ["image", "cgroup"],
  });
  expect(await runtime.execution.sandbox.current()).toBeNull();
  missing = [];
  const pinned = await runtime.execution.sandbox.current();
  expect(pinned?.kernel.sha256).toBe(
    createHash("sha256").update("kernel artifact").digest("hex"),
  );
  await database.engine.query(
    "UPDATE cloud_installation SET organization_id=NULL",
  );
  expect(await runtime.execution.sandbox.read(owner)).toBeNull();
});

it("runs cloud profiles on this server without setup and keeps them current", async () => {
  runtime.execution.hostedRunners.start("http://127.0.0.1:9");
  missing = ["qemu"];
  await runtime.execution.hostedRunners.tick();
  expect(await hostedWorkers()).toEqual([]);
  missing = [];
  const remote = await runtime.execution.workers.register(
    owner,
    profileId,
    "Remote",
  );
  expect(remote.token).toMatch(/^mch_cloud_worker_/);
  await database.engine.query(
    "UPDATE cloud_execution_profiles SET revision=revision+1 WHERE id=$1",
    [profileId],
  );
  await runtime.execution.hostedRunners.tick();
  const [hosted] = await hostedWorkers();
  expect(hosted).toMatchObject({
    name: "This server",
    hosted: { state: "running", error: null },
  });
  await expect(
    runtime.execution.workers.rotate(owner, hosted!.id),
  ).rejects.toMatchObject({ code: "hosted_runner" });
  await runtime.execution.hostedRunners.tick();
  expect(await hostedWorkers()).toHaveLength(1);
  const revisions = (
    await database.engine.query<{ id: string; current: boolean }>(
      "SELECT w.id,w.profile_revision=p.revision AS current FROM cloud_execution_workers w JOIN cloud_execution_profiles p ON p.id=w.profile_id",
    )
  ).rows;
  expect(revisions.find((row) => row.id === hosted!.id)?.current).toBe(true);
  expect(revisions.find((row) => row.id === remote.id)?.current).toBe(false);
  await runtime.execution.workers.revoke(owner, randomUUID(), hosted!.id);
  await runtime.execution.hostedRunners.tick();
  expect(runtime.execution.hostedRunners.status(hosted!.id)).toEqual({
    state: "stopped",
    error: null,
  });
  expect(await hostedWorkers()).toEqual([]);
  await rm(join(machdochDataDirectory, "runners", hosted!.id), {
    recursive: true,
    force: true,
  });
}, 30_000);
