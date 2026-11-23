import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudActor } from "../../../lib/cloud-contract";
import {
  intakeSources,
  type IntakeSource,
} from "../../../lib/cloud-automation-contract";
import type {
  LoopRejectionReason,
  LoopSource,
  LoopSourceSecret,
  LoopSourceState,
} from "../../../lib/cloud-loop-contract";
import { sourceEventContent } from "../../../lib/loop-source-events";
import { CloudError, requireMembership } from "../access";
import { queueAutomationEvents } from "../automation/automation-events";
import type { CloudDatabase, CloudSql } from "../database";

export function hashSourceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function recordSourceRejection(
  sql: CloudSql,
  rejection: {
    organizationId: string;
    source: string;
    loopId: string | null;
    reason: LoopRejectionReason;
  },
): Promise<void> {
  await sql.query(
    "INSERT INTO cloud_loop_source_rejections (organization_id,id,source,loop_id,reason) VALUES ($1,$2,$3,$4,$5)",
    [
      rejection.organizationId,
      randomUUID(),
      rejection.source,
      rejection.loopId,
      rejection.reason,
    ],
  );
}

export async function sourceIntakeRejection(
  sql: CloudSql,
  organizationId: string,
  source: LoopSource,
): Promise<LoopRejectionReason | null> {
  const row = (
    await sql.query<{ enabled: boolean; loopsEnabled: boolean }>(
      `SELECT src.enabled,COALESCE(st.enabled,true) AS "loopsEnabled" FROM cloud_loop_sources src
      LEFT JOIN cloud_loop_settings st ON st.organization_id=src.organization_id
      WHERE src.organization_id=$1 AND src.source=$2`,
      [organizationId, source],
    )
  ).rows[0];
  if (!row?.loopsEnabled) return "loops_disabled";
  return row.enabled ? null : "source_disabled";
}

function isIntakeSource(source: string): source is IntakeSource {
  return (intakeSources as readonly string[]).includes(source);
}

export class CloudLoopSources {
  constructor(
    private readonly database: CloudDatabase,
    private readonly origin: string,
    private readonly wake: () => void,
  ) {}

  list(actor: CloudActor): Promise<LoopSourceState[]> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      return (
        await sql.query<LoopSourceState & Record<string, unknown>>(
          `SELECT s.source,s.enabled,s.secret_hash IS NOT NULL AS configured,s.rotated_at AS "rotatedAt",
            (SELECT count(*)::integer FROM cloud_loop_trusted_sources t WHERE t.organization_id=s.organization_id AND t.source=s.source) AS "trustedBy",
            (SELECT jsonb_build_object('reason',r.reason,'at',r.received_at) FROM cloud_loop_source_rejections r
              WHERE r.organization_id=s.organization_id AND r.source=s.source ORDER BY r.received_at DESC LIMIT 1) AS "lastRejection"
          FROM cloud_loop_sources s WHERE s.organization_id=$1
          ORDER BY array_position(ARRAY['webhook','email','github','gitlab','sentry','grafana','teams','slack'],s.source)`,
          [actor.organizationId],
        )
      ).rows;
    });
  }

  setEnabled(
    actor: CloudActor,
    source: LoopSource,
    enabled: boolean,
  ): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      await sql.query(
        "UPDATE cloud_loop_sources SET enabled=$3 WHERE organization_id=$1 AND source=$2",
        [actor.organizationId, source, enabled],
      );
    });
  }

  rotate(actor: CloudActor, source: LoopSource): Promise<LoopSourceSecret> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor, "ai.manage");
      if (!isIntakeSource(source))
        throw new CloudError(
          422,
          "loop_source_secret",
          "This source uses its own connection.",
        );
      const secret = randomBytes(32).toString("base64url");
      await sql.query(
        "UPDATE cloud_loop_sources SET secret_hash=$3,rotated_at=clock_timestamp() WHERE organization_id=$1 AND source=$2",
        [actor.organizationId, source, hashSourceSecret(secret)],
      );
      return {
        source,
        secret,
        url: `${this.origin}/api/v1/loops/sources/${actor.organizationId}/${source}/${secret}`,
      };
    });
  }

  async receive(
    organizationId: string,
    source: string,
    secret: string,
    payload: unknown,
  ): Promise<{ queued: number }> {
    if (!isIntakeSource(source))
      throw new CloudError(404, "not_found", "Source is unavailable.");
    const result = await this.database.transaction(async (sql) => {
      const known = (
        await sql.query<{ matches: boolean }>(
          "SELECT secret_hash IS NOT NULL AND secret_hash=$3 AS matches FROM cloud_loop_sources WHERE organization_id=$1 AND source=$2",
          [organizationId, source, hashSourceSecret(secret)],
        )
      ).rows[0];
      if (!known)
        throw new CloudError(404, "not_found", "Source is unavailable.");
      const rejection = known.matches
        ? await sourceIntakeRejection(sql, organizationId, source)
        : "invalid_secret";
      if (rejection) {
        await recordSourceRejection(sql, {
          organizationId,
          source,
          loopId: null,
          reason: rejection,
        });
        return { rejection, queued: 0 };
      }
      const queued = await queueAutomationEvents(sql, {
        organizationId,
        teamId: null,
        issueId: null,
        actorId: null,
        source,
        events: [
          {
            kind: "source_event",
            source,
            ...sourceEventContent(source, payload),
            payload,
          },
        ],
      });
      return { rejection: null, queued };
    });
    if (result.rejection)
      throw new CloudError(
        result.rejection === "invalid_secret" ? 401 : 409,
        `loop_${result.rejection}`,
        "The event was rejected.",
      );
    if (result.queued) this.wake();
    return { queued: result.queued };
  }
}
