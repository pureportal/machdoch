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
    brand: { ...workspace.organization.brand, color: "#a79bff" },
    logoDark: null,
    logoLight: null,
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

export async function seedCloudCollaboration(fixture, seeded, { gitApiUrl }) {
  const api = (path, method, data) =>
    cloudApi(fixture, fixture.ownerContext, path, method, data);
  const workspace = await api("workspace");
  const project = (name) =>
    workspace.projects.find((entry) => entry.name === name);
  const developerExperience = project("Developer experience");
  const connectivity = project("Client connectivity");
  const provider = (await api("ai-providers")).providers[0];
  await api(`projects/${seeded.project.id}/updates`, "POST", {
    health: "on_track",
    body: "Reconnect handling is in review. Next we harden the handoff context.",
  });
  const sql = await fixture.database.connect();
  try {
    const updates = [
      [
        seeded.project.id,
        "at_risk",
        "Reconnects ship this week, but the patch review flow slips because the diff viewer needs a rewrite.",
        "**Progress**\n- ENG-1 reconnect with backoff is in review\n- ENG-4 filters persist across views\n\n**Next**\n- ENG-3 review changes before applying a patch\n\n**Risks**\n- Diff viewer rewrite may push ENG-3 by a week",
        1,
      ],
      [
        developerExperience.id,
        "on_track",
        "Faster feedback loops are on schedule; the CI cache cut build times by 40%.",
        "**Progress**\n- CI cache enabled for all branches\n\n**Next**\n- Local preview environments",
        2,
      ],
      [
        connectivity.id,
        "off_track",
        "Paused until the relay redesign lands; the target date will be missed.",
        "**Risks**\n- Relay redesign has no owner yet",
        3,
      ],
    ];
    for (const [projectId, health, summary, body, days] of updates)
      await sql.query(
        `INSERT INTO cloud_project_updates (organization_id,id,project_id,author_id,health,summary,body,generated,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,clock_timestamp()-$8*interval '1 day')`,
        [
          workspace.organization.id,
          randomUUID(),
          projectId,
          workspace.actor.id,
          health,
          summary,
          body,
          days,
        ],
      );
  } finally {
    sql.release();
  }
  for (const [title, url] of [
    ["Engineering handbook", "https://handbook.example.com/engineering"],
    ["On-call runbook", "https://docs.example.com/runbooks/cloud"],
  ])
    await api(`teams/${seeded.team.id}/resources`, "POST", { title, url });
  await api("views", "POST", {
    name: "Engineering board",
    shared: true,
    filters: {
      teamId: seeded.team.id,
      view: "board",
      density: "compact",
      completed: "week",
      hide: "created,updated",
    },
  });
  await api("views", "POST", {
    name: "Urgent and high",
    shared: false,
    filters: { priority: "urgent,high", group: "assignee" },
  });
  const nightly = await api("automations", "POST", {
    name: "Nightly sync",
    teamId: seeded.team.id,
    trigger: { kind: "manual" },
    actions: [
      {
        kind: "create_issue",
        title: "Sync report {{date}}",
        description: "",
        statusId: null,
        priority: "none",
        assigneeId: null,
        labelIds: [],
        subIssue: false,
      },
    ],
  });
  await api("automations", "POST", {
    name: "Track failed automations",
    teamId: seeded.team.id,
    trigger: {
      kind: "automation_finished",
      automationIds: [],
      outcomes: ["failed"],
    },
    actions: [
      {
        kind: "create_issue",
        title: "Automation failed: {{run.automation}}",
        description: "{{run.error}}",
        statusId: null,
        priority: "high",
        assigneeId: null,
        labelIds: [],
        subIssue: false,
      },
    ],
  });
  await api("automations", "POST", {
    name: "After the nightly sync",
    teamId: seeded.team.id,
    trigger: {
      kind: "automation_finished",
      automationIds: [nightly.id],
      outcomes: ["succeeded"],
    },
    actions: [
      {
        kind: "set_automation_enabled",
        automationId: nightly.id,
        enabled: false,
      },
    ],
  });
  if (provider)
    await api("automations", "POST", {
      name: "Weekly project updates",
      teamId: seeded.team.id,
      trigger: {
        kind: "schedule",
        frequency: "weekly",
        time: "16:00",
        weekday: 5,
        timeZone: "Europe/Berlin",
        forEachIssue: false,
      },
      actions: [
        {
          kind: "write_project_updates",
          projectIds: [],
          providerId: provider.id,
          model: provider.models[0],
        },
      ],
    });
  await api("git/github", "PUT", {
    revision: 0,
    apiUrl: gitApiUrl,
    token: "ghp_organization_fixture_token_0000",
    automate: false,
  });
  await api("git/github/repositories", "POST", {
    fullName: "northstar/cloud-workspace",
  });
  await api("git/github/sync", "POST", {});
  await api("git/accounts/github", "PUT", {
    revision: 0,
    apiUrl: gitApiUrl,
    token: "ghp_owner_fixture_token_00000000000",
  });
}
