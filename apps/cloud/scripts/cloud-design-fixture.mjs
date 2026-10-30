import { randomUUID } from "node:crypto";
import {
  cloudApi,
  statusReference,
  executionProviderFixture,
} from "./cloud-browser-fixture.mjs";

export async function seedCloudDesign(fixture) {
  const api = (path, method, data) =>
    cloudApi(fixture, fixture.ownerContext, path, method, data);
  const workspace = await api("workspace");
  await api("organization", "PATCH", {
    revision: workspace.organization.revision,
    name: "Northstar Studio",
    accent: "violet",
  });
  const team = await api("teams", "POST", {
    name: "Engineering",
    key: "ENG",
    visibility: "organization",
    estimateScale: [1, 2, 3, 5, 8, 13].map((points) => ({
      label: String(points),
      points,
    })),
  });
  await api("teams", "POST", {
    name: "Product & Design",
    key: "DES",
    visibility: "organization",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Cloud workspace",
    description:
      "A shared workspace for planning, development, and connected clients.",
    status: "active",
    leadId: workspace.actor.id,
    startsOn: "2026-10-05",
    targetOn: "2026-12-11",
  });
  await api("projects", "POST", {
    teamId: team.id,
    name: "Developer experience",
    description:
      "Faster feedback, reliable automation, and thoughtful everyday tools.",
    status: "planned",
    targetOn: "2027-01-29",
  });
  await api("projects", "POST", {
    teamId: team.id,
    name: "Client connectivity",
    description: "Keep remote development environments within reach.",
    status: "paused",
    leadId: workspace.actor.id,
  });
  const cycle = await api("cycles", "POST", {
    teamId: team.id,
    name: "October · Cycle 04",
    startsOn: "2026-10-19",
    endsOn: "2026-11-02",
    timezone: "Europe/Berlin",
    capacity: 40,
  });
  await api("cycles", "POST", {
    teamId: team.id,
    name: "November · Cycle 05",
    startsOn: "2026-11-02",
    endsOn: "2026-11-16",
    timezone: "Europe/Berlin",
    capacity: 45,
  });
  const titles = [
    "Reconnect clients after an interrupted session",
    "Add project context to agent handoffs",
    "Review changes before applying a patch",
    "Keep issue filters when switching views",
    "Improve keyboard navigation in planning",
    "Show live execution progress",
    "Support workspace-level provider settings",
    "Document the release workflow",
    "Retain drafts across navigation",
    "Surface actionable connection errors",
    "Polish cycle planning on mobile",
    "Update team permissions",
  ];
  const states = [
    "active",
    "review",
    "ready",
    "complete",
    "backlog",
    "active",
    "ready",
    "complete",
    "blocked",
    "ready",
    "backlog",
    "complete",
  ];
  const priorities = [
    "high",
    "normal",
    "high",
    "low",
    "normal",
    "urgent",
    "normal",
    "low",
    "high",
    "normal",
    "none",
    "low",
  ];
  const issues = [];
  for (const [i, title] of titles.entries()) {
    const created = await api("issues", "POST", {
      teamId: team.id,
      projectId: project.id,
      cycleId: cycle.id,
      title,
      status: await statusReference(
        fixture,
        fixture.ownerContext,
        team.id,
        states[i],
      ),
      priority: priorities[i],
      estimate: ["3", "5", "8"][i % 3],
      assigneeId: i % 3 ? workspace.actor.id : null,
      description:
        "Preserve the current workspace and recover the connection without losing pending work.",
      acceptanceCriteria:
        "The session reconnects successfully. Pending changes and the selected workspace are preserved.",
    });
    issues.push(await api(`issues/${created.id}`));
  }
  const provider = await executionProviderFixture(
    fixture,
    fixture.ownerContext,
    { name: "Engineering AI", models: ["design-fixture-model"] },
  );
  const profile = await api("execution-profiles", "POST", {
    projectId: project.id,
    name: "Cloud development",
    target: "cloud",
    repository: "https://github.com/example/cloud-workspace",
    baseCommit: "a".repeat(40),
    providerId: provider.id,
    model: "design-fixture-model",
    maxDurationSeconds: 1800,
    maxTokens: 10000,
    requiredChecks: [
      { name: "Unit tests", command: "pnpm test", timeoutSeconds: 120 },
    ],
  });
  const task = await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issues[0].id, revision: issues[0].revision },
  });
  await api("runs", "POST", {
    profileId: profile.id,
    subject: { kind: "issue", id: issues[2].id, revision: issues[2].revision },
  });
  for (const name of [
    "Weekly dependency review",
    "Release readiness",
    "Workspace maintenance",
  ]) {
    await api("schedules", "POST", {
      name,
      teamId: team.id,
      action: {
        kind: "create-issue",
        issue: {
          teamId: team.id,
          projectId: project.id,
          title: name,
          priority: "normal",
        },
      },
      recurrence: {
        kind: "interval",
        start: "2026-11-01T09:00:00Z",
        everyMs: 604800000,
      },
      missed: "latest",
      catchUpLimit: 1,
      lookbackHours: 24,
    });
  }
  const chatId = randomUUID(),
    turnId = randomUUID(),
    requestId = randomUUID();
  const sql = await fixture.database.connect();
  try {
    await sql.query("BEGIN");
    await sql.query(
      "INSERT INTO cloud_chats (organization_id,id,user_id,title) VALUES ($1,$2,$3,$4)",
      [
        workspace.organization.id,
        chatId,
        workspace.actor.id,
        "Planning the next cycle",
      ],
    );
    await sql.query(
      "INSERT INTO cloud_chat_turns (organization_id,id,chat_id,provider_id,model,sequence,prompt,answer,state,request_id) VALUES ($1,$2,$3,$4,'design-fixture-model',1,$5,$6,'complete',$7)",
      [
        workspace.organization.id,
        turnId,
        chatId,
        provider.id,
        "How should we prepare for the next development cycle?",
        "Start with the outcomes you want to deliver.\n\n1. **Review unfinished work.** Reassess priority before carrying it forward.\n2. **Estimate together.** Use planning poker to uncover uncertainty.\n3. **Agree on capacity.** Leave room for review and unexpected work.\n\nKeep the cycle focused on a small set of achievable outcomes.",
        requestId,
      ],
    );
    await sql.query(
      "INSERT INTO cloud_inference_calls (organization_id,id,turn_id,actor_id,provider_id,provider_revision,model,user_prompt,system_prompt,reserved_tokens,actual_tokens,max_output_tokens,budget_day,state,deadline_at) VALUES ($1,$2,$3,$4,$5,1,'design-fixture-model','Design verification','Design verification',100,80,512,CURRENT_DATE,'complete',clock_timestamp())",
      [
        workspace.organization.id,
        requestId,
        turnId,
        workspace.actor.id,
        provider.id,
      ],
    );
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  } finally {
    sql.release();
  }
  return { team, project, cycle, issues, task, chatId };
}
