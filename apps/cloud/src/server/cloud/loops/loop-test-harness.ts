import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  automationInputSchema,
  type AutomationAction,
} from "../../../lib/cloud-automation-contract";
import {
  loopConfigSchema,
  type LoopConfig,
} from "../../../lib/cloud-loop-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

export let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
export let runtime: CloudRuntime;
export let owner: CloudActor;
export let member: CloudActor;
export let teamId: string;
export let providerId: string;
export const webhookFetch = vi.fn<typeof fetch>();
export const modelReplies: string[] = [];

export function useLoopTestRuntime() {
  beforeAll(async () => {
    database = await createTestCloudDatabase();
  }, 120_000);
  afterAll(async () => {
    await database?.close();
  });
  afterEach(async () => {
    await runtime?.inference.worker.close();
  });
  beforeEach(async () => {
    await database.engine.exec(
      "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
    );
    const organizationId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    const actors: CloudActor[] = [];
    for (const role of ["owner", "member"]) {
      const userId = randomUUID();
      await database.engine.query(
        "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
        [userId, `${role}@example.test`, role],
      );
      await database.engine.query(
        "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
        [organizationId, userId, role],
      );
      actors.push({ organizationId, userId });
    }
    [owner, member] = actors as [CloudActor, CloudActor];
    webhookFetch.mockReset();
    modelReplies.length = 0;
    runtime = createCloudRuntime(database, "https://cloud.example.test", {
      credentialsCipher: new SettingsCipher(randomBytes(32)),
      automationFetch: webhookFetch,
      modelAdapterFactory: async () => ({
        startTurn: async () => ({
          text: modelReplies.shift() ?? "Report body",
          toolCalls: [],
          usage: { totalTokens: 4 },
        }),
        continueTurn: async () => {
          throw new Error("Agent rounds restart with the full transcript.");
        },
      }),
    });
    teamId = (
      await runtime.planning.createTeam(owner, randomUUID(), {
        name: "Team",
        key: "TM",
        visibility: "organization",
        estimateScale: defaultEstimateScale,
      })
    ).id;
    providerId = (
      await runtime.aiProviders.create(owner, randomUUID(), {
        name: "Provider",
        provider: "openai",
        region: null,
        models: ["fixture-model"],
        apiKey: "private-fixture-key",
        maxOutputTokens: 256,
        dailyTokenBudget: 200000,
        maxConcurrentRequests: 4,
      })
    ).id;
  });
}

export const loops = () => runtime.automations.loops;

export async function settle() {
  for (let round = 0; round < 6; round++)
    await runtime.automations.dispatcher.tick();
}

export async function createIssue(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
}

export async function createLoop(
  actions: unknown[],
  config: (current: LoopConfig) => LoopConfig = (current) => current,
  name = "Loop",
): Promise<string> {
  const { id } = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automationInputSchema.parse({
      name,
      teamId,
      trigger: { kind: "manual" },
      actions: actions as AutomationAction[],
    }),
  );
  const loop = await loops().get(owner, id);
  await loops().updateConfig(owner, randomUUID(), id, {
    revision: loop.revision,
    config: loopConfigSchema.parse(config(loop.config)),
  });
  return id;
}

export async function run(id: string, issueId: string | null): Promise<string> {
  const { runIds } = await runtime.automations.service.run(
    owner,
    randomUUID(),
    id,
    { issueId },
  );
  await settle();
  return runIds[0]!;
}

export async function comments(issueId: string): Promise<string[]> {
  return (await runtime.comments.list(owner, issueId)).map(
    (comment) => comment.body,
  );
}

export async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("Expected the call to fail.");
    },
    (error: unknown) => error,
  );
}
