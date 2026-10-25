import { randomUUID } from "node:crypto";
import { defaultEstimateScale } from "../../../lib/cloud-contract";
import {
  scheduleInputSchema,
  type ScheduleInput,
} from "../../../lib/cloud-schedule-contract";
import type { createTestCloudDatabase } from "../test-database";
import { createCloudRuntime } from "../runtime";
import { SettingsCipher } from "../../settings-crypto";

export async function createScheduleFixture(
  database: Awaited<ReturnType<typeof createTestCloudDatabase>>,
) {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Automation')",
    [actor.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) VALUES($1,'owner@example.test','Owner','fixture')",
    [actor.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [actor.organizationId, actor.userId],
  );
  const runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(Buffer.alloc(32, 8)),
  });
  const teamId = (
    await runtime.planning.createTeam(actor, randomUUID(), {
      name: "Automation",
      key: "AU",
      visibility: "private",
      estimateScale: defaultEstimateScale,
    })
  ).id;
  const projectId = (
    await runtime.projects.create(actor, randomUUID(), {
      name: "Project",
      teamId,
      description: "",
    })
  ).id;
  const providerId = (
    await runtime.aiProviders.create(actor, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture"],
      apiKey: "fixture-key",
      maxOutputTokens: 512,
      dailyTokenBudget: 100000,
      maxConcurrentRequests: 4,
    })
  ).id;
  const profileId = (
    await runtime.execution.profiles.create(actor, randomUUID(), {
      name: "Sandbox",
      projectId,
      target: "cloud",
      repository: "https://github.com/example/project",
      baseCommit: "a".repeat(40),
      providerId,
      model: "fixture",
      maxTokens: 10000,
      maxDurationSeconds: 3600,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    })
  ).id;
  return { runtime, actor, teamId, projectId, providerId, profileId };
}
export function scheduledTaskInput({
  teamId,
  projectId,
  profileId,
}: {
  teamId: string;
  projectId: string;
  profileId: string;
}): ScheduleInput {
  return scheduleInputSchema.parse({
    name: "Nightly maintenance",
    teamId,
    action: {
      kind: "run-task",
      run: {
        profileId,
        subject: {
          kind: "project",
          id: projectId,
          revision: 1,
          purpose: "maintenance",
          objective: "Review dependency versions",
          acceptanceCriteria: "Produce a report with evidence",
        },
      },
      profileRevision: 1,
      maxRuns: 2,
      maxTokens: 20000,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    },
    recurrence: {
      kind: "interval",
      start: new Date(Date.now() - 3600000).toISOString(),
      everyMs: 60000,
    },
    missed: "bounded-all",
    catchUpLimit: 3,
    lookbackHours: 1,
  });
}
