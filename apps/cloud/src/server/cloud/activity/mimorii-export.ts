import type { SettingsCipher } from "../../settings-crypto";
import { isCloudError } from "../access";
import type { CloudDatabase } from "../database";
import {
  mimoriiConnection,
  type MimoriiConnection,
} from "./mimorii-connections";
import {
  MimoriiDeliveryError,
  mimoriiBatchSize,
  mimoriiLogBatch,
  sendMimoriiBatch,
  type ExportedActivity,
} from "./mimorii-protocol";

const retentionDays = 90;
const pruneIntervalMs = 60 * 60 * 1000;

export class CloudMimoriiExporter {
  private prunedAt = 0;

  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async tick(): Promise<number> {
    await this.prune();
    const due = await this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ organizationId: string }>(
            `UPDATE cloud_mimorii_connections SET retry_at=clock_timestamp()+interval '60 seconds'
            WHERE organization_id IN (
              SELECT c.organization_id FROM cloud_mimorii_connections c
              WHERE c.enabled AND c.retry_at<=clock_timestamp()
              AND EXISTS (SELECT 1 FROM cloud_ai_activity a WHERE a.organization_id=c.organization_id AND a.exported_at IS NULL AND a.occurred_at>=c.connected_at)
              ORDER BY c.retry_at LIMIT 10 FOR UPDATE SKIP LOCKED)
            RETURNING organization_id AS "organizationId"`,
          )
        ).rows,
    );
    let exported = 0;
    for (const { organizationId } of due)
      exported = Math.max(exported, await this.export(organizationId));
    return exported;
  }

  private async prune(): Promise<void> {
    if (Date.now() - this.prunedAt < pruneIntervalMs) return;
    await this.database.transaction((sql) =>
      sql.query(
        `DELETE FROM cloud_ai_activity WHERE occurred_at<clock_timestamp()-interval '${retentionDays} days'`,
      ),
    );
    this.prunedAt = Date.now();
  }

  private async export(organizationId: string): Promise<number> {
    let connection: MimoriiConnection;
    let activities: ExportedActivity[];
    try {
      ({ connection, activities } = await this.database.transaction(
        async (sql) => ({
          connection: await mimoriiConnection(sql, this.cipher, organizationId),
          activities: (
            await sql.query<ExportedActivity & Record<string, unknown>>(
              `SELECT a.id,a.organization_id AS "organizationId",a.kind,a.status,a.title,a.detail,
              to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
              COALESCE(u.name,a.instance_name,'Unknown member') AS "actorName",a.model,a.provider,a.tokens,a.duration_ms AS "durationMs",
              a.run_id AS "runId",r.title AS "runTitle",i.identifier AS "issueIdentifier",a.chat_id AS "chatId",a.instance_id AS "instanceId",a.instance_name AS "instanceName"
              FROM cloud_ai_activity a JOIN cloud_mimorii_connections c ON c.organization_id=a.organization_id
              LEFT JOIN cloud_users u ON u.id=a.actor_id
              LEFT JOIN cloud_runs r ON r.organization_id=a.organization_id AND r.id=a.run_id
              LEFT JOIN cloud_issues i ON i.organization_id=r.organization_id AND i.id=r.issue_id
              WHERE a.organization_id=$1 AND a.exported_at IS NULL AND a.occurred_at>=c.connected_at
              ORDER BY a.sequence LIMIT ${mimoriiBatchSize}`,
              [organizationId],
            )
          ).rows,
        }),
      ));
    } catch (error) {
      if (!isCloudError(error)) throw error;
      await this.fail(organizationId, null, error.message, null);
      return 0;
    }
    if (!activities.length) return 0;
    try {
      const result = await sendMimoriiBatch(
        connection.url,
        connection.token,
        mimoriiLogBatch(activities),
        this.transport,
      );
      await this.database.transaction(async (sql) => {
        await sql.query(
          "UPDATE cloud_ai_activity SET exported_at=clock_timestamp() WHERE organization_id=$1 AND id=ANY($2::uuid[])",
          [organizationId, activities.map((activity) => activity.id)],
        );
        await sql.query(
          `UPDATE cloud_mimorii_connections SET delivered_at=clock_timestamp(),delivered_entries=delivered_entries+$3,
          rejected_entries=rejected_entries+$4,last_error=$5,failures=0,retry_at=clock_timestamp()
          WHERE organization_id=$1 AND revision=$2`,
          [
            organizationId,
            connection.revision,
            result.accepted + result.duplicates,
            result.rejected,
            result.rejection,
          ],
        );
      });
      return activities.length;
    } catch (error) {
      if (!(error instanceof MimoriiDeliveryError)) throw error;
      await this.fail(
        organizationId,
        connection.revision,
        error.message,
        error.retryAfterSeconds,
      );
      return 0;
    }
  }

  private async fail(
    organizationId: string,
    revision: number | null,
    message: string,
    retryAfterSeconds: number | null,
  ): Promise<void> {
    await this.database.transaction((sql) =>
      sql.query(
        `UPDATE cloud_mimorii_connections SET failures=failures+1,last_error=$3,
        retry_at=clock_timestamp()+make_interval(secs => GREATEST($4::integer,LEAST(600,5*power(2,LEAST(failures,7))))::double precision)
        WHERE organization_id=$1 AND ($2::integer IS NULL OR revision=$2)`,
        [
          organizationId,
          revision,
          message.slice(0, 500),
          retryAfterSeconds ?? 0,
        ],
      ),
    );
  }
}
