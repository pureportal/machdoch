import { createSecret, hashSecret, validateSecret } from "../../crypto";
import { recordEvent } from "../access";
import type { CloudDatabase, CloudSql } from "../database";
import { lockUserSessions } from "../session-issuance";

export const rememberedSessionCookie = "__Host-machdoch_cloud_remember";
const rememberedDays = 30;
const concurrentRestoreSeconds = 30;

export interface RememberedCredential {
  token: string;
  maxAge: number;
}
export type RememberedRestore =
  | { kind: "unchanged" }
  | { kind: "forgotten" }
  | {
      kind: "restored";
      sessionToken: string;
      csrfToken: string;
      remember: RememberedCredential | null;
    };

interface RememberedSession extends Record<string, unknown> {
  id: string;
  userId: string;
  organizationId: string;
  current: boolean;
  concurrent: boolean | null;
  restorable: boolean;
}

export async function rememberSession(
  sql: CloudSql,
  sessionId: string,
): Promise<RememberedCredential> {
  const token = createSecret("mch_cloud_remember");
  await sql.query(
    "UPDATE cloud_sessions SET remember_hash=$2,remembered_until=clock_timestamp()+make_interval(days => $3) WHERE id=$1",
    [sessionId, hashSecret(token), rememberedDays],
  );
  return { token, maxAge: rememberedDays * 24 * 60 * 60 };
}

export class CloudRememberedSessions {
  constructor(private readonly database: CloudDatabase) {}

  restore(
    sessionToken: string,
    rememberToken: string,
  ): Promise<RememberedRestore> {
    if (!validateSecret(rememberToken, "mch_cloud_remember"))
      return Promise.resolve({ kind: "forgotten" });
    return this.database.transaction(async (sql) => {
      if (
        validateSecret(sessionToken, "mch_cloud_session") &&
        (
          await sql.query(
            "SELECT 1 FROM cloud_sessions s WHERE token_hash=$1 AND cloud_session_valid(s)",
            [hashSecret(sessionToken)],
          )
        ).rows.length
      )
        return { kind: "unchanged" };
      const rememberHash = hashSecret(rememberToken);
      const owner = (
        await sql.query<{ user_id: string }>(
          "SELECT user_id FROM cloud_sessions WHERE remember_hash=$1 OR remember_previous_hash=$1",
          [rememberHash],
        )
      ).rows[0];
      if (!owner) return { kind: "forgotten" };
      await lockUserSessions(sql, [owner.user_id]);
      const session = (
        await sql.query<RememberedSession>(
          `SELECT s.id,s.user_id AS "userId",s.organization_id AS "organizationId",s.remember_hash=$1 AS current,
          s.remember_rotated_at>clock_timestamp()-make_interval(secs => $2) AS concurrent,cloud_session_restorable(s) AS restorable
          FROM cloud_sessions s WHERE s.remember_hash=$1 OR s.remember_previous_hash=$1 FOR UPDATE OF s`,
          [rememberHash, concurrentRestoreSeconds],
        )
      ).rows[0];
      if (!session) return { kind: "forgotten" };
      if (!session.restorable || (!session.current && !session.concurrent)) {
        await sql.query("DELETE FROM cloud_sessions WHERE id=$1", [session.id]);
        if (session.restorable)
          await recordEvent(
            sql,
            session,
            "sessions.remembered_token_reused",
            session.userId,
            1,
            { sessionId: session.id },
          );
        return { kind: "forgotten" };
      }
      const nextSession = createSecret("mch_cloud_session"),
        csrfToken = createSecret("mch_cloud_csrf");
      const rotated = session.current
        ? createSecret("mch_cloud_remember")
        : null;
      const result = (
        await sql.query<{ maxAge: number }>(
          `UPDATE cloud_sessions SET token_hash=$2,csrf_hash=$3,touched_at=clock_timestamp(),
          expires_at=LEAST(clock_timestamp()+interval '12 hours',remembered_until),
          remember_previous_hash=CASE WHEN $4::text IS NULL THEN remember_previous_hash ELSE remember_hash END,
          remember_hash=COALESCE($4,remember_hash),
          remember_rotated_at=CASE WHEN $4::text IS NULL THEN remember_rotated_at ELSE clock_timestamp() END
          WHERE id=$1 RETURNING floor(extract(epoch FROM remembered_until-clock_timestamp()))::integer AS "maxAge"`,
          [
            session.id,
            hashSecret(nextSession),
            hashSecret(csrfToken),
            rotated ? hashSecret(rotated) : null,
          ],
        )
      ).rows[0]!;
      return {
        kind: "restored",
        sessionToken: nextSession,
        csrfToken,
        remember: rotated ? { token: rotated, maxAge: result.maxAge } : null,
      };
    });
  }
}
