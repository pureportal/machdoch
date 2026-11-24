import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { CloudActor } from "../../lib/cloud-contract";
import {
  notificationPreferenceMatrix,
  type NotificationDevice,
  type NotificationPreferenceOverride,
  type NotificationSchedule,
  type NotificationSettings,
  type notificationPreferenceUpdateSchema,
  type pushSubscriptionSchema,
} from "../../lib/notification-preferences";
import type { SettingsCipher } from "../settings-crypto";
import { CloudError, requireMembership } from "./access";
import { requireCredentialStorage } from "./credential-storage";
import type { CloudDatabase, CloudSql } from "./database";
import { createVapidKeys, type VapidKeys } from "./web-push";

const pushKeyContext = Buffer.from("machdoch.cloud/notification-push-key");
const deviceColumns = `id,label,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

export function chatTargetContext(
  organizationId: string,
  userId: string,
): Buffer {
  return Buffer.from(
    `machdoch.cloud/notification-chat:${organizationId}:${userId}`,
  );
}

export async function notificationSchedule(
  sql: CloudSql,
  organizationId: string,
  userId: string,
): Promise<NotificationSchedule> {
  const row = (
    await sql.query<{
      snoozedUntil: string | null;
      quietStart: number | null;
      quietEnd: number | null;
      timeZone: string;
    }>(
      `SELECT to_char(snoozed_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "snoozedUntil",
         quiet_start AS "quietStart",quiet_end AS "quietEnd",time_zone AS "timeZone"
       FROM cloud_notification_schedules WHERE organization_id=$1 AND user_id=$2`,
      [organizationId, userId],
    )
  ).rows[0];
  if (!row) return { snoozedUntil: null, quietHours: null, timeZone: "UTC" };
  return {
    snoozedUntil: row.snoozedUntil,
    quietHours:
      row.quietStart === null || row.quietEnd === null
        ? null
        : { start: row.quietStart, end: row.quietEnd },
    timeZone: row.timeZone,
  };
}

export async function pushKeys(
  sql: CloudSql,
  cipher: SettingsCipher | null,
): Promise<VapidKeys> {
  const storage = await requireCredentialStorage(sql, cipher);
  let row = (
    await sql.query<{ publicKey: string; privateKey: Uint8Array }>(
      'SELECT public_key AS "publicKey",private_key AS "privateKey" FROM cloud_push_keys WHERE id',
    )
  ).rows[0];
  if (!row) {
    const created = createVapidKeys();
    const privateKey = storage.encrypt(
      Buffer.from(created.privateKey),
      pushKeyContext,
    );
    await sql.query(
      "INSERT INTO cloud_push_keys (id,public_key,private_key) VALUES (true,$1,$2)",
      [created.publicKey, privateKey],
    );
    row = { publicKey: created.publicKey, privateKey };
  }
  try {
    return {
      publicKey: row.publicKey,
      privateKey: storage
        .decrypt(Buffer.from(row.privateKey), pushKeyContext)
        .toString("utf8"),
    };
  } catch {
    throw new CloudError(
      503,
      "credential_storage",
      "Push keys cannot be unlocked. Contact your administrator.",
    );
  }
}

export class CloudNotificationSettingsService {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  get(actor: CloudActor): Promise<NotificationSettings> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const overrides = (
        await sql.query<
          NotificationPreferenceOverride & Record<string, unknown>
        >(
          "SELECT kind,channel,enabled FROM cloud_notification_preferences WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId, actor.userId],
        )
      ).rows;
      const targets = (
        await sql.query<{ chatHost: string | null; emailAvailable: boolean }>(
          `SELECT (SELECT host FROM cloud_notification_chat_targets WHERE organization_id=$1 AND user_id=$2) AS "chatHost",
             EXISTS (SELECT 1 FROM cloud_email_settings WHERE organization_id=$1 AND enabled) AS "emailAvailable"`,
          [actor.organizationId, actor.userId],
        )
      ).rows[0]!;
      const devices = (
        await sql.query<NotificationDevice & Record<string, unknown>>(
          `SELECT ${deviceColumns} FROM cloud_push_subscriptions WHERE organization_id=$1 AND user_id=$2 ORDER BY created_at,id`,
          [actor.organizationId, actor.userId],
        )
      ).rows;
      return {
        preferences: notificationPreferenceMatrix(overrides),
        schedule: await notificationSchedule(
          sql,
          actor.organizationId,
          actor.userId,
        ),
        chatHost: targets.chatHost,
        emailAvailable: targets.emailAvailable,
        devices,
      };
    });
  }

  setPreference(
    actor: CloudActor,
    update: z.infer<typeof notificationPreferenceUpdateSchema>,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      await sql.query(
        `INSERT INTO cloud_notification_preferences (organization_id,user_id,kind,channel,enabled) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (organization_id,user_id,kind,channel) DO UPDATE SET enabled=EXCLUDED.enabled`,
        [
          actor.organizationId,
          actor.userId,
          update.kind,
          update.channel,
          update.enabled,
        ],
      );
    });
  }

  setSchedule(
    actor: CloudActor,
    schedule: NotificationSchedule,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      await sql.query(
        `INSERT INTO cloud_notification_schedules (organization_id,user_id,snoozed_until,quiet_start,quiet_end,time_zone) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id,user_id) DO UPDATE SET snoozed_until=EXCLUDED.snoozed_until,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,time_zone=EXCLUDED.time_zone`,
        [
          actor.organizationId,
          actor.userId,
          schedule.snoozedUntil,
          schedule.quietHours?.start ?? null,
          schedule.quietHours?.end ?? null,
          schedule.timeZone,
        ],
      );
      await sql.query(
        `UPDATE cloud_notification_deliveries d SET deliver_after=clock_timestamp(),updated_at=clock_timestamp()
         FROM cloud_notifications n
         WHERE d.organization_id=$1 AND d.state='queued' AND n.organization_id=d.organization_id AND n.id=d.notification_id AND n.user_id=$2`,
        [actor.organizationId, actor.userId],
      );
    });
  }

  setChatTarget(actor: CloudActor, url: string | null): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      if (url === null) {
        await sql.query(
          "DELETE FROM cloud_notification_chat_targets WHERE organization_id=$1 AND user_id=$2",
          [actor.organizationId, actor.userId],
        );
        return;
      }
      const storage = await requireCredentialStorage(sql, this.cipher);
      await sql.query(
        `INSERT INTO cloud_notification_chat_targets (organization_id,user_id,host,url) VALUES ($1,$2,$3,$4)
         ON CONFLICT (organization_id,user_id) DO UPDATE SET host=EXCLUDED.host,url=EXCLUDED.url,updated_at=clock_timestamp()`,
        [
          actor.organizationId,
          actor.userId,
          new URL(url).hostname,
          storage.encrypt(
            Buffer.from(url),
            chatTargetContext(actor.organizationId, actor.userId),
          ),
        ],
      );
    });
  }

  pushKey(actor: CloudActor): Promise<{ publicKey: string }> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return { publicKey: (await pushKeys(sql, this.cipher)).publicKey };
    });
  }

  addDevice(
    actor: CloudActor,
    subscription: z.infer<typeof pushSubscriptionSchema>,
  ): Promise<NotificationDevice> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      return (
        await sql.query<NotificationDevice & Record<string, unknown>>(
          `INSERT INTO cloud_push_subscriptions (organization_id,id,user_id,endpoint,p256dh,auth,label) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (organization_id,endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,label=EXCLUDED.label
           RETURNING ${deviceColumns}`,
          [
            actor.organizationId,
            randomUUID(),
            actor.userId,
            subscription.endpoint,
            subscription.keys.p256dh,
            subscription.keys.auth,
            subscription.label,
          ],
        )
      ).rows[0]!;
    });
  }

  removeDevice(actor: CloudActor, id: string): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const removed = await sql.query(
        "DELETE FROM cloud_push_subscriptions WHERE organization_id=$1 AND user_id=$2 AND id=$3 RETURNING id",
        [actor.organizationId, actor.userId, id],
      );
      if (!removed.rows.length)
        throw new CloudError(
          404,
          "not_found",
          "This device is no longer registered.",
        );
    });
  }
}
