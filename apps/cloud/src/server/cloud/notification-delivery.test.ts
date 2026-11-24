import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../lib/cloud-contract";
import { SettingsCipher } from "../settings-crypto";
import type { OutgoingMail } from "./auth/smtp";
import { cloudMigrations } from "./database";
import {
  CloudNotificationDelivery,
  type NotificationMessage,
  type NotificationTransports,
} from "./notification-delivery";
import { createCloudRuntime, type CloudRuntime } from "./runtime";
import { createTestCloudDatabase } from "./test-database";
import type { PushResult, PushTarget } from "./web-push";

const origin = "https://cloud.example.test";
const chatUrl = "https://hooks.slack.com/services/T000/B000/secret";
const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
const cipher = new SettingsCipher(randomBytes(32));

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let delivery: CloudNotificationDelivery;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;
let sent: {
  email: OutgoingMail[];
  chat: { url: string; text: string }[];
  push: { target: PushTarget; message: NotificationMessage }[];
};
let pushResult: PushResult;
let chatFailure: Error | null;

const transports: NotificationTransports = {
  async email(mail) {
    sent.email.push(mail);
  },
  async chat(url, text) {
    if (chatFailure) throw chatFailure;
    sent.chat.push({ url, text });
  },
  async push(target, _keys, _subject, message) {
    sent.push.push({ target, message });
    return pushResult;
  },
};

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, origin, { credentialsCipher: cipher });
  delivery = new CloudNotificationDelivery(
    database,
    cipher,
    origin,
    transports,
  );
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  sent = { email: [], chat: [], push: [] };
  pushResult = "delivered";
  chatFailure = null;
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users,cloud_push_keys CASCADE",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Acme')",
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
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Team",
      key: "TM",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

async function connectEverything() {
  await database.engine.query(
    "INSERT INTO cloud_email_settings (organization_id,host,port,security,from_address,enabled) VALUES ($1,'smtp.example.test',465,'tls','cloud@example.test',true)",
    [owner.organizationId],
  );
  await runtime.notifications.settings.setChatTarget(member, chatUrl);
  await runtime.notifications.settings.addDevice(member, {
    endpoint,
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
    label: "Phone",
  });
}

async function assign(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title, assigneeId: member.userId }),
  );
}

async function deliveries() {
  return (
    await database.engine.query<{
      channel: string;
      state: string;
      reason: string | null;
      attempts: number;
    }>(
      "SELECT channel,state,reason,attempts FROM cloud_notification_deliveries ORDER BY channel",
    )
  ).rows;
}

describe("notification preferences and delivery", () => {
  it("routes events to the inbox and external channels by preference", async () => {
    await connectEverything();
    const issue = await assign("Export");
    expect(await deliveries()).toEqual([
      { channel: "email", state: "queued", reason: null, attempts: 0 },
      { channel: "mobile", state: "queued", reason: null, attempts: 0 },
    ]);
    expect(await delivery.deliverDue(20)).toBe(2);
    expect(sent.email).toEqual([
      expect.objectContaining({
        recipient: "member@example.test",
        senderName: "Acme",
        subject: "TM-1 Export",
        text: `owner assigned you\n\n${origin}/cloud/issues/${issue.id}`,
      }),
    ]);
    expect(sent.push).toEqual([
      {
        target: expect.objectContaining({ endpoint }),
        message: {
          title: "TM-1 Export",
          body: "owner assigned you",
          url: `${origin}/cloud/issues/${issue.id}`,
        },
      },
    ]);
    expect((await deliveries()).map((row) => row.state)).toEqual([
      "sent",
      "sent",
    ]);

    await database.engine.exec("DELETE FROM cloud_notifications");
    const settings = runtime.notifications.settings;
    await settings.setPreference(member, {
      kind: "assigned",
      channel: "chat",
      enabled: true,
    });
    await settings.setPreference(member, {
      kind: "assigned",
      channel: "in_app",
      enabled: false,
    });
    await settings.setPreference(member, {
      kind: "assigned",
      channel: "mobile",
      enabled: false,
    });
    await assign("Chat only");
    expect((await deliveries()).map((row) => row.channel)).toEqual([
      "chat",
      "email",
    ]);
    expect(await runtime.inbox.list(member)).toEqual([]);
    expect(await runtime.inbox.unread(member)).toBe(0);
    await delivery.deliverDue(20);
    expect(sent.chat).toEqual([
      { url: chatUrl, text: expect.stringContaining("owner assigned you") },
    ]);

    await database.engine.exec("DELETE FROM cloud_notifications");
    for (const channel of ["email", "chat"] as const)
      await settings.setPreference(member, {
        kind: "assigned",
        channel,
        enabled: false,
      });
    await assign("Silenced");
    expect(
      (await database.engine.query("SELECT 1 FROM cloud_notifications")).rows,
    ).toEqual([]);
    expect((await settings.get(member)).preferences.assigned).toEqual({
      in_app: false,
      email: false,
      chat: false,
      mobile: false,
    });
  });

  it("keeps unavailable channels out of the queue", async () => {
    await assign("No targets");
    expect(await deliveries()).toEqual([]);
    expect(await runtime.inbox.list(member)).toHaveLength(1);
    const settings = await runtime.notifications.settings.get(member);
    expect(settings).toMatchObject({
      chatHost: null,
      emailAvailable: false,
      devices: [],
      schedule: { snoozedUntil: null, quietHours: null, timeZone: "UTC" },
    });
  });

  it("holds deliveries while snoozed or in quiet hours", async () => {
    await connectEverything();
    const settings = runtime.notifications.settings;
    const snoozedUntil = new Date(Date.now() + 3_600_000).toISOString();
    await settings.setSchedule(member, {
      snoozedUntil,
      quietHours: null,
      timeZone: "UTC",
    });
    await assign("Snoozed");
    expect(await delivery.deliverDue(20)).toBe(2);
    expect(sent.email).toEqual([]);
    const held = await database.engine.query<{
      state: string;
      attempts: number;
      due: string;
    }>(
      "SELECT state,attempts,deliver_after AS due FROM cloud_notification_deliveries",
    );
    expect(held.rows.map(({ state, attempts }) => [state, attempts])).toEqual([
      ["queued", 0],
      ["queued", 0],
    ]);
    expect(new Date(held.rows[0]!.due).toISOString()).toBe(snoozedUntil);

    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    await settings.setSchedule(member, {
      snoozedUntil: null,
      quietHours: { start: (minute + 1439) % 1440, end: (minute + 60) % 1440 },
      timeZone: "UTC",
    });
    expect(await delivery.deliverDue(20)).toBe(2);
    expect(sent.email).toEqual([]);

    await settings.setSchedule(member, {
      snoozedUntil: null,
      quietHours: null,
      timeZone: "Europe/Berlin",
    });
    await delivery.deliverDue(20);
    expect(sent.email).toHaveLength(1);
    expect(sent.push).toHaveLength(1);
  });

  it("re-checks access, preferences and read state at delivery time", async () => {
    await connectEverything();
    await assign("Private");
    await database.engine.query(
      "UPDATE cloud_teams SET visibility='private' WHERE id=$1",
      [teamId],
    );
    await database.engine.query(
      "DELETE FROM cloud_team_memberships WHERE user_id=$1",
      [member.userId],
    );
    await delivery.deliverDue(20);
    expect(await deliveries()).toEqual([
      { channel: "email", state: "skipped", reason: "forbidden", attempts: 1 },
      { channel: "mobile", state: "skipped", reason: "forbidden", attempts: 1 },
    ]);

    await database.engine.exec("DELETE FROM cloud_notifications");
    await database.engine.query(
      "UPDATE cloud_teams SET visibility='organization' WHERE id=$1",
      [teamId],
    );
    await assign("Deactivated");
    await database.engine.query(
      "UPDATE cloud_memberships SET active=false WHERE user_id=$1",
      [member.userId],
    );
    await delivery.deliverDue(20);
    expect((await deliveries()).map((row) => row.reason)).toEqual([
      "forbidden",
      "forbidden",
    ]);
    await database.engine.query(
      "UPDATE cloud_memberships SET active=true WHERE user_id=$1",
      [member.userId],
    );

    await database.engine.exec("DELETE FROM cloud_notifications");
    await assign("Changed mind");
    await runtime.notifications.settings.setPreference(member, {
      kind: "assigned",
      channel: "email",
      enabled: false,
    });
    const [entry] = await runtime.inbox.list(member);
    await runtime.inbox.update(member, {
      kind: "read",
      ids: [entry!.id],
      read: true,
    });
    await delivery.deliverDue(20);
    expect((await deliveries()).map((row) => row.reason)).toEqual([
      "disabled",
      "seen",
    ]);
    expect(sent).toEqual({ email: [], chat: [], push: [] });
  });

  it("drops expired devices and retries failing transports", async () => {
    await connectEverything();
    await runtime.notifications.settings.setPreference(member, {
      kind: "assigned",
      channel: "chat",
      enabled: true,
    });
    pushResult = "gone";
    chatFailure = new Error("Webhook down");
    await assign("Flaky");
    await delivery.deliverDue(20);
    expect(await deliveries()).toEqual([
      { channel: "chat", state: "queued", reason: "error", attempts: 1 },
      { channel: "email", state: "sent", reason: null, attempts: 1 },
      {
        channel: "mobile",
        state: "skipped",
        reason: "unavailable",
        attempts: 1,
      },
    ]);
    expect((await runtime.notifications.settings.get(member)).devices).toEqual(
      [],
    );
    await database.engine.exec(
      "UPDATE cloud_notification_deliveries SET attempts=4,deliver_after=clock_timestamp() WHERE channel='chat'",
    );
    await delivery.deliverDue(20);
    expect((await deliveries())[0]).toMatchObject({
      state: "failed",
      attempts: 5,
    });
  });

  it("recovers expired leases", async () => {
    await connectEverything();
    await assign("Crashed");
    await database.engine.exec(
      "UPDATE cloud_notification_deliveries SET state='sending',attempts=1,lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(await delivery.deliverDue(20)).toBe(2);
    expect((await deliveries()).map((row) => row.state)).toEqual([
      "sent",
      "sent",
    ]);
  });

  it("manages chat targets, push keys and devices per member", async () => {
    const settings = runtime.notifications.settings;
    const key = await settings.pushKey(member);
    expect(Buffer.from(key.publicKey, "base64url")).toHaveLength(65);
    expect(await settings.pushKey(owner)).toEqual(key);
    const stored = (
      await database.engine.query<{ url: Uint8Array }>(
        "SELECT url FROM cloud_notification_chat_targets",
      )
    ).rows;
    expect(stored).toEqual([]);
    await settings.setChatTarget(member, chatUrl);
    const encrypted = (
      await database.engine.query<{ url: Uint8Array; host: string }>(
        "SELECT url,host FROM cloud_notification_chat_targets",
      )
    ).rows[0]!;
    expect(encrypted.host).toBe("hooks.slack.com");
    expect(Buffer.from(encrypted.url).toString("utf8")).not.toContain("secret");
    expect((await settings.get(member)).chatHost).toBe("hooks.slack.com");
    await settings.setChatTarget(member, null);
    expect((await settings.get(member)).chatHost).toBeNull();

    const subscription = {
      endpoint,
      keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      label: "Laptop",
    };
    const device = await settings.addDevice(member, subscription);
    await expect(settings.removeDevice(owner, device.id)).rejects.toMatchObject(
      { status: 404 },
    );
    const moved = await settings.addDevice(owner, subscription);
    expect(moved.id).toBe(device.id);
    expect((await settings.get(member)).devices).toEqual([]);
    await settings.removeDevice(owner, device.id);
    expect((await settings.get(owner)).devices).toEqual([]);
  });
});

it("adds constrained notification preference tables", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    for (const name of cloudMigrations)
      await engine.exec(
        await readFile(
          new URL(`./migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const inbox = await engine.query<{ column_default: string }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name='cloud_notifications' AND column_name='inbox'",
    );
    expect(inbox.rows).toEqual([{ column_default: "true" }]);
    const organizationId = randomUUID();
    const userId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Acme')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'a@example.test','A','test')",
      [userId],
    );
    await engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'member')",
      [organizationId, userId],
    );
    await expect(
      engine.query(
        "INSERT INTO cloud_notification_preferences (organization_id,user_id,kind,channel,enabled) VALUES ($1,$2,'assigned','sms',true)",
        [organizationId, userId],
      ),
    ).rejects.toThrow();
    await expect(
      engine.query(
        "INSERT INTO cloud_notification_schedules (organization_id,user_id,quiet_start,quiet_end) VALUES ($1,$2,60,60)",
        [organizationId, userId],
      ),
    ).rejects.toThrow();
    await expect(
      engine.query(
        "INSERT INTO cloud_notification_schedules (organization_id,user_id,quiet_start) VALUES ($1,$2,60)",
        [organizationId, userId],
      ),
    ).rejects.toThrow();
    await expect(
      engine.query(
        "INSERT INTO cloud_push_subscriptions (organization_id,id,user_id,endpoint,p256dh,auth,label) VALUES ($1,$2,$3,'http://insecure.test',$4,$5,'Phone')",
        [organizationId, randomUUID(), userId, "B".repeat(87), "A".repeat(22)],
      ),
    ).rejects.toThrow();
  } finally {
    await engine.close();
  }
}, 120_000);
