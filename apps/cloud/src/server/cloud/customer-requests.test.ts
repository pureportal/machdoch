import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { triageDecisionSchema } from "../../lib/cloud-triage-contract";
import { workflowDefinitionSchema } from "../../lib/cloud-workflow-contract";
import { handleCloudApi } from "./api";
import { cloudMigrations } from "./database";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let triageId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test");
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "member", "viewer"]) {
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
  [owner, member, viewer] = actors as [CloudActor, CloudActor, CloudActor];
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

async function addTriageStatus() {
  const workflow = await runtime.workflows.get(owner, teamId);
  triageId = randomUUID();
  const definition = workflowDefinitionSchema.parse({
    revision: workflow.revision,
    defaultStatusId: workflow.defaultStatusId,
    statuses: [
      { id: triageId, name: "Triage", category: "triage", archived: false },
      ...workflow.statuses.map(({ revision: _, ...status }) => status),
    ],
  });
  await runtime.workflows.update(owner, randomUUID(), teamId, {
    definition,
    impactDigest: (await runtime.workflows.preview(owner, teamId, definition))
      .digest,
  });
}

async function openChannel(channel: "email" | "slack" | "teams" | "webhook") {
  const requests = runtime.customerRequests;
  await requests.setChannelEnabled(owner, channel, true);
  return (await requests.rotate(owner, channel)).secret;
}

async function configured() {
  await addTriageStatus();
  await runtime.customerRequests.updateSettings(owner, teamId);
}

async function summary(issueId: string) {
  const issues = await runtime.planning.listIssueSummaries(viewer, { teamId });
  return issues.find((issue) => issue.id === issueId)!;
}

describe("customer request intake", () => {
  it("creates triage items from email, Slack, Teams and webhook intake", async () => {
    await configured();
    const organizationId = owner.organizationId;
    const requests = runtime.customerRequests;
    const email = await requests.receive(
      organizationId,
      "email",
      await openChannel("email"),
      {
        subject: "Export to CSV",
        text: "We need CSV exports.",
        from: "Jane <jane@acme.test>",
        messageId: "<m1@acme.test>",
      },
    );
    const slack = await requests.receive(
      organizationId,
      "slack",
      await openChannel("slack"),
      { event: { text: "Dark mode please", user: "U1", client_msg_id: "s1" } },
    );
    const teams = await requests.receive(
      organizationId,
      "teams",
      await openChannel("teams"),
      {
        id: "t1",
        text: "<p>SAML login</p>",
        from: { user: { displayName: "Ann" } },
      },
    );
    const webhook = await requests.receive(
      organizationId,
      "webhook",
      await openChannel("webhook"),
      {
        title: "Audit log",
        body: "Need an audit log.",
        customer: { name: "Globex", domain: "globex.test" },
        externalId: "w1",
      },
    );
    for (const result of [email, slack, teams, webhook])
      expect(result.created).toBe(true);
    const triage = await runtime.triage.list(member, teamId);
    expect(triage.map((issue) => issue.title).sort()).toEqual([
      "Audit log",
      "Dark mode please",
      "Export to CSV",
      "SAML login",
    ]);
    const issue = await runtime.planning.getIssue(member, email.issueId);
    expect(issue.status.id).toBe(triageId);
    expect(issue.description).toBe("We need CSV exports.");
    expect(
      (await requests.customers(viewer)).map((customer) => [
        customer.name,
        customer.domain,
        customer.requestCount,
      ]),
    ).toEqual([["Globex", "globex.test", 1]]);
  });

  it("links requests to customers and deduplicates them into one issue with a request count", async () => {
    await configured();
    const requests = runtime.customerRequests;
    const acme = await requests.createCustomer(owner, {
      name: "Acme",
      domain: "acme.test",
    });
    const secret = await openChannel("email");
    const receive = (from: string, subject: string, messageId: string) =>
      requests.receive(owner.organizationId, "email", secret, {
        subject,
        text: "Body",
        from,
        messageId,
      });
    const first = await receive("jane@acme.test", "Export to CSV", "m1");
    const again = await receive("jane@acme.test", "Export to CSV", "m1");
    expect(again).toEqual({ ...first, created: false });
    const reply = await receive("bob@acme.test", "Re: export to csv!", "m2");
    expect(reply).toMatchObject({
      issueId: first.issueId,
      requestId: first.requestId,
      created: false,
    });
    const other = await receive("eve@initech.test", "Export to CSV", "m3");
    expect(other.issueId).toBe(first.issueId);
    expect(other.requestId).not.toBe(first.requestId);
    expect((await summary(first.issueId)).requestCount).toBe(2);
    const listed = await requests.forIssue(viewer, first.issueId);
    expect(
      listed.map((request) => [request.customerName, request.mentions]),
    ).toEqual(
      expect.arrayContaining([
        ["Acme", 2],
        [null, 1],
      ]),
    );
    expect(
      (await requests.customers(viewer)).find(
        (customer) => customer.id === acme.id,
      )?.requestCount,
    ).toBe(1);
    const unrelated = await receive("jane@acme.test", "Gantt charts", "m4");
    expect(unrelated.created).toBe(true);
    expect((await summary(unrelated.issueId)).requestCount).toBe(1);
  });

  it("starts a new issue once the matching issue is closed", async () => {
    await configured();
    const secret = await openChannel("webhook");
    const receive = (externalId: string) =>
      runtime.customerRequests.receive(
        owner.organizationId,
        "webhook",
        secret,
        { title: "Bulk edit", externalId },
      );
    const first = await receive("a");
    await database.engine.query(
      `UPDATE cloud_issues i SET status_id=s.id,state=s.category FROM cloud_workflow_statuses s
      WHERE i.id=$1 AND s.organization_id=i.organization_id AND s.team_id=i.team_id AND s.category='complete'`,
      [first.issueId],
    );
    const second = await receive("b");
    expect(second.created).toBe(true);
    expect(second.issueId).not.toBe(first.issueId);
  });

  it("moves requests to the original when triage marks a duplicate", async () => {
    await configured();
    const requests = runtime.customerRequests;
    const acme = await requests.createCustomer(owner, {
      name: "Acme",
      domain: "acme.test",
    });
    const secret = await openChannel("email");
    const original = await requests.receive(
      owner.organizationId,
      "email",
      secret,
      { subject: "CSV export", from: "a@acme.test", messageId: "1" },
    );
    const duplicate = await requests.receive(
      owner.organizationId,
      "email",
      secret,
      { subject: "Export spreadsheets", from: "b@acme.test", messageId: "2" },
    );
    await requests.receive(owner.organizationId, "email", secret, {
      subject: "Export spreadsheets",
      from: "c@other.test",
      messageId: "3",
    });
    const issue = await runtime.planning.getIssue(owner, duplicate.issueId);
    await runtime.triage.decide(
      owner,
      randomUUID(),
      duplicate.issueId,
      triageDecisionSchema.parse({
        decision: "duplicate",
        revision: issue.revision,
        duplicateOfId: original.issueId,
      }),
    );
    expect((await summary(duplicate.issueId)).requestCount).toBe(0);
    expect((await summary(original.issueId)).requestCount).toBe(2);
    const merged = await requests.forIssue(owner, original.issueId);
    expect(
      merged.find((request) => request.customerId === acme.id)?.mentions,
    ).toBe(2);
    const repeat = await requests.receive(
      owner.organizationId,
      "email",
      secret,
      { subject: "Export spreadsheets", from: "b@acme.test", messageId: "2" },
    );
    expect(repeat.issueId).toBe(original.issueId);
  });

  it("relinks a request to a customer and merges it with that customer's request", async () => {
    await configured();
    const requests = runtime.customerRequests;
    const acme = await requests.createCustomer(owner, {
      name: "Acme",
      domain: "acme.test",
    });
    const secret = await openChannel("email");
    const first = await requests.receive(
      owner.organizationId,
      "email",
      secret,
      {
        subject: "SSO",
        from: "a@acme.test",
        messageId: "1",
      },
    );
    const second = await requests.receive(
      owner.organizationId,
      "email",
      secret,
      { subject: "SSO", from: "x@gmail.test", messageId: "2" },
    );
    await expect(
      requests.link(viewer, second.requestId, acme.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(await requests.link(member, second.requestId, acme.id)).toEqual({
      id: first.requestId,
    });
    const listed = await requests.forIssue(member, first.issueId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ customerName: "Acme", mentions: 2 });
    await requests.link(member, first.requestId, null);
    expect((await requests.forIssue(member, first.issueId))[0]).toMatchObject({
      customerId: null,
    });
  });

  it("rejects intake without a valid secret, enabled channel or triage team", async () => {
    const requests = runtime.customerRequests;
    const organizationId = owner.organizationId;
    await expect(
      requests.receive(organizationId, "email", "x".repeat(43), {}),
    ).rejects.toMatchObject({ status: 404 });
    const { secret } = await requests.rotate(owner, "email");
    await expect(
      requests.receive(organizationId, "email", "y".repeat(43), {
        subject: "A",
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      requests.receive(organizationId, "email", secret, { subject: "A" }),
    ).rejects.toMatchObject({ code: "request_channel_disabled" });
    await requests.setChannelEnabled(owner, "email", true);
    await expect(
      requests.receive(organizationId, "email", secret, { subject: "A" }),
    ).rejects.toMatchObject({ code: "request_intake_unconfigured" });
    await expect(requests.updateSettings(owner, teamId)).rejects.toMatchObject({
      code: "triage_status_required",
    });
    await configured();
    await expect(
      requests.receive(organizationId, "email", secret, {}),
    ).rejects.toMatchObject({ code: "request_empty" });
    await expect(
      requests.receive(organizationId, "sms", secret, { subject: "A" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("limits configuration to settings managers", async () => {
    const requests = runtime.customerRequests;
    await expect(requests.settings(member)).rejects.toMatchObject({
      status: 403,
    });
    await expect(requests.rotate(member, "email")).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      requests.createCustomer(member, { name: "Acme", domain: null }),
    ).rejects.toMatchObject({ status: 403 });
    await requests.createCustomer(owner, { name: "Acme", domain: "acme.test" });
    await expect(
      requests.createCustomer(owner, { name: "acme", domain: null }),
    ).rejects.toMatchObject({ code: "customer_name_taken" });
    await expect(
      requests.createCustomer(owner, { name: "Other", domain: "acme.test" }),
    ).rejects.toMatchObject({ code: "customer_domain_taken" });
    const settings = await requests.settings(owner);
    expect(settings).toEqual({
      teamId: null,
      channels: ["email", "slack", "teams", "webhook"].map((channel) => ({
        channel,
        enabled: false,
        configured: false,
        rotatedAt: null,
      })),
    });
  });

  it("accepts intake through the public HTTP route", async () => {
    await configured();
    const { url } = await runtime.customerRequests.rotate(owner, "webhook");
    await runtime.customerRequests.setChannelEnabled(owner, "webhook", true);
    const send = () =>
      handleCloudApi(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Webhook ask", externalId: "h1" }),
        }),
        "127.0.0.1",
        runtime,
      );
    const created = await send();
    expect(created.status).toBe(201);
    const body = (await created.json()) as { issueId: string };
    expect((await send()).status).toBe(200);
    expect((await summary(body.issueId)).requestCount).toBe(1);
  });

  it("keeps the issue creation path unchanged for manual issues", async () => {
    const created = await runtime.planning.createIssue(
      member,
      randomUUID(),
      issueInputSchema.parse({ teamId, title: "Manual" }),
    );
    expect((await summary(created.id)).requestCount).toBe(0);
  });
});

it("adds customer request tables on top of existing issues", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("077-customer-requests.sql");
    for (const name of cloudMigrations.slice(0, index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const organizationId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    for (const name of cloudMigrations.slice(index))
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    await engine.query(
      "INSERT INTO cloud_customers (organization_id,id,name,domain) VALUES ($1,$2,'Acme','acme.test')",
      [organizationId, randomUUID()],
    );
    await expect(
      engine.query(
        "INSERT INTO cloud_customers (organization_id,id,name,domain) VALUES ($1,$2,'ACME',NULL)",
        [organizationId, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      engine.query(
        "INSERT INTO cloud_customers (organization_id,id,name,domain) VALUES ($1,$2,'Bad','Not A Domain')",
        [organizationId, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(
      engine.query(
        "INSERT INTO cloud_request_channels (organization_id,channel) VALUES ($1,'sms')",
        [organizationId],
      ),
    ).rejects.toThrow();
  } finally {
    await engine.close();
  }
}, 120_000);
