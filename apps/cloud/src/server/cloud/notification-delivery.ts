import type { InboxEntry } from "../../lib/cloud-inbox-contract";
import {
  describeInboxEntry,
  inboxEntryPath,
  inboxEntryTitle,
} from "../../lib/inbox-entries";
import {
  defaultNotificationPreference,
  deliveryHold,
  type DeliveryChannel,
} from "../../lib/notification-preferences";
import type { SettingsCipher } from "../settings-crypto";
import { CloudError, teamVisibility } from "./access";
import { sendMail, type OutgoingMail } from "./auth/smtp";
import { smtpConnection } from "./auth/email-settings";
import type { CloudDatabase, CloudSql } from "./database";
import { inboxEntryColumns, inboxEntrySource } from "./notifications";
import {
  chatTargetContext,
  notificationSchedule,
  pushKeys,
} from "./notification-settings";
import {
  sendWebPush,
  type PushResult,
  type PushTarget,
  type VapidKeys,
} from "./web-push";

export interface NotificationMessage {
  title: string;
  body: string;
  url: string;
}
export interface NotificationTransports {
  email(mail: OutgoingMail, signal: AbortSignal): Promise<void>;
  chat(url: string, text: string, signal: AbortSignal): Promise<void>;
  push(
    target: PushTarget,
    keys: VapidKeys,
    subject: string,
    message: NotificationMessage,
    signal: AbortSignal,
  ): Promise<PushResult>;
}

const deliveryTimeoutMs = 20_000;
const leaseSeconds = 120;
const maximumAttempts = 5;
export const notificationDeliveryBatchSize = 20;

export const defaultNotificationTransports: NotificationTransports = {
  email: sendMail,
  async chat(url, text, signal) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new Error(`Chat webhook answered ${response.status}`);
  },
  push: (target, keys, subject, message, signal) =>
    sendWebPush(target, keys, subject, message, signal),
};

interface Delivery {
  organizationId: string;
  notificationId: string;
  channel: DeliveryChannel;
  attempts: number;
}
type Dispatch =
  | { kind: "email"; mail: OutgoingMail }
  | { kind: "chat"; url: string; text: string }
  | {
      kind: "mobile";
      keys: VapidKeys;
      targets: (PushTarget & { id: string })[];
    };
type Outcome =
  | { state: "skipped"; reason: string }
  | { state: "held" }
  | { state: "send"; message: NotificationMessage; dispatch: Dispatch };

export class CloudNotificationDelivery {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly origin: string,
    private readonly transports: NotificationTransports,
  ) {}

  async deliverDue(limit: number): Promise<number> {
    const claimed = await this.database.transaction(async (sql) => {
      await sql.query(
        "UPDATE cloud_notification_deliveries SET state='queued',lease_expires_at=NULL,updated_at=clock_timestamp() WHERE state='sending' AND lease_expires_at<clock_timestamp()",
      );
      return (
        await sql.query<Delivery & Record<string, unknown>>(
          `WITH due AS (
             SELECT organization_id,notification_id,channel FROM cloud_notification_deliveries
             WHERE state='queued' AND deliver_after<=clock_timestamp() ORDER BY deliver_after LIMIT $1 FOR UPDATE SKIP LOCKED)
           UPDATE cloud_notification_deliveries d SET state='sending',attempts=d.attempts+1,
             lease_expires_at=clock_timestamp()+make_interval(secs=>$2),updated_at=clock_timestamp()
           FROM due WHERE d.organization_id=due.organization_id AND d.notification_id=due.notification_id AND d.channel=due.channel
           RETURNING d.organization_id AS "organizationId",d.notification_id AS "notificationId",d.channel,d.attempts`,
          [limit, leaseSeconds],
        )
      ).rows;
    });
    for (const delivery of claimed) await this.deliver(delivery);
    return claimed.length;
  }

  private async deliver(delivery: Delivery): Promise<void> {
    try {
      const outcome = await this.database.transaction((sql) =>
        this.prepare(sql, delivery),
      );
      if (outcome.state === "held") return;
      if (outcome.state === "skipped")
        return await this.finish(delivery, "skipped", outcome.reason);
      const signal = AbortSignal.timeout(deliveryTimeoutMs);
      const dispatch = outcome.dispatch;
      if (dispatch.kind === "email")
        await this.transports.email(dispatch.mail, signal);
      else if (dispatch.kind === "chat")
        await this.transports.chat(dispatch.url, dispatch.text, signal);
      else if (!(await this.push(delivery, dispatch, outcome.message, signal)))
        return await this.finish(delivery, "skipped", "unavailable");
      await this.finish(delivery, "sent", null);
    } catch {
      if (delivery.attempts >= maximumAttempts)
        return this.finish(delivery, "failed", "error");
      await this.database.transaction((sql) =>
        sql.query(
          `UPDATE cloud_notification_deliveries SET state='queued',lease_expires_at=NULL,reason='error',
             deliver_after=clock_timestamp()+make_interval(mins=>$4),updated_at=clock_timestamp()
           WHERE organization_id=$1 AND notification_id=$2 AND channel=$3`,
          [
            delivery.organizationId,
            delivery.notificationId,
            delivery.channel,
            delivery.attempts ** 2,
          ],
        ),
      );
    }
  }

  private async push(
    delivery: Delivery,
    dispatch: Extract<Dispatch, { kind: "mobile" }>,
    message: NotificationMessage,
    signal: AbortSignal,
  ): Promise<boolean> {
    const results = await Promise.allSettled(
      dispatch.targets.map((target) =>
        this.transports.push(
          target,
          dispatch.keys,
          this.origin,
          message,
          signal,
        ),
      ),
    );
    const gone = dispatch.targets
      .filter((_, index) => {
        const result = results[index]!;
        return result.status === "fulfilled" && result.value === "gone";
      })
      .map((target) => target.id);
    if (gone.length)
      await this.database.transaction((sql) =>
        sql.query(
          "DELETE FROM cloud_push_subscriptions WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [delivery.organizationId, gone],
        ),
      );
    if (
      results.some(
        (result) =>
          result.status === "fulfilled" && result.value === "delivered",
      )
    )
      return true;
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    return false;
  }

  private async prepare(sql: CloudSql, delivery: Delivery): Promise<Outcome> {
    const { organizationId, notificationId, channel } = delivery;
    const recipient = (
      await sql.query<
        InboxEntry & {
          userId: string;
          dismissed: boolean;
          email: string;
          organization: string;
          enabled: boolean | null;
        } & Record<string, unknown>
      >(
        `SELECT ${inboxEntryColumns},n.user_id AS "userId",n.dismissed_at IS NOT NULL AS dismissed,u.email,o.name AS organization,pref.enabled
         ${inboxEntrySource}
         JOIN cloud_users u ON u.id=n.user_id
         JOIN cloud_organizations o ON o.id=n.organization_id
         LEFT JOIN cloud_notification_preferences pref ON pref.organization_id=n.organization_id AND pref.user_id=n.user_id AND pref.kind=n.kind AND pref.channel=$3
         WHERE n.organization_id=$1 AND n.id=$2 AND m.active AND NOT u.disabled AND ${teamVisibility}`,
        [organizationId, notificationId, channel],
      )
    ).rows[0];
    if (!recipient) return { state: "skipped", reason: "forbidden" };
    if (
      !(
        recipient.enabled ??
        defaultNotificationPreference(recipient.kind, channel)
      )
    )
      return { state: "skipped", reason: "disabled" };
    if (recipient.read || recipient.dismissed)
      return { state: "skipped", reason: "seen" };
    const hold = deliveryHold(
      new Date(),
      await notificationSchedule(sql, organizationId, recipient.userId),
    );
    if (hold) {
      await sql.query(
        `UPDATE cloud_notification_deliveries SET state='queued',lease_expires_at=NULL,attempts=attempts-1,deliver_after=$4,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND notification_id=$2 AND channel=$3`,
        [organizationId, notificationId, channel, hold],
      );
      return { state: "held" };
    }
    const message = {
      title: inboxEntryTitle(recipient),
      body: describeInboxEntry(recipient),
      url: new URL(inboxEntryPath(recipient), this.origin).toString(),
    };
    const dispatch = await this.dispatch(sql, delivery, recipient, message);
    return dispatch
      ? { state: "send", message, dispatch }
      : { state: "skipped", reason: "unavailable" };
  }

  private async dispatch(
    sql: CloudSql,
    { organizationId, notificationId, channel }: Delivery,
    recipient: { userId: string; email: string; organization: string },
    message: NotificationMessage,
  ): Promise<Dispatch | null> {
    if (channel === "email") {
      const enabled = (
        await sql.query(
          "SELECT 1 FROM cloud_email_settings WHERE organization_id=$1 AND enabled",
          [organizationId],
        )
      ).rows.length;
      if (!enabled) return null;
      let connection;
      try {
        connection = await smtpConnection(sql, this.cipher, organizationId);
      } catch (error) {
        if (error instanceof CloudError) return null;
        throw error;
      }
      return {
        kind: "email",
        mail: {
          connection,
          senderName: recipient.organization,
          recipient: recipient.email,
          messageId: `<notification-${notificationId}@machdoch.cloud>`,
          subject: message.title,
          text: `${message.body}\n\n${message.url}`,
        },
      };
    }
    if (channel === "chat") {
      const row = (
        await sql.query<{ url: Uint8Array }>(
          "SELECT url FROM cloud_notification_chat_targets WHERE organization_id=$1 AND user_id=$2",
          [organizationId, recipient.userId],
        )
      ).rows[0];
      if (!row || !this.cipher) return null;
      return {
        kind: "chat",
        url: this.cipher
          .decrypt(
            Buffer.from(row.url),
            chatTargetContext(organizationId, recipient.userId),
          )
          .toString("utf8"),
        text: `${message.title}\n${message.body}\n${message.url}`,
      };
    }
    const targets = (
      await sql.query<PushTarget & { id: string } & Record<string, unknown>>(
        "SELECT id,endpoint,p256dh,auth FROM cloud_push_subscriptions WHERE organization_id=$1 AND user_id=$2 ORDER BY created_at,id",
        [organizationId, recipient.userId],
      )
    ).rows;
    if (!targets.length) return null;
    return { kind: "mobile", keys: await pushKeys(sql, this.cipher), targets };
  }

  private finish(
    delivery: Delivery,
    state: "sent" | "skipped" | "failed",
    reason: string | null,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await sql.query(
        `UPDATE cloud_notification_deliveries SET state=$4,reason=$5,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE organization_id=$1 AND notification_id=$2 AND channel=$3`,
        [
          delivery.organizationId,
          delivery.notificationId,
          delivery.channel,
          state,
          reason,
        ],
      );
    });
  }
}
