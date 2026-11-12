import { hashSecret } from "../crypto";
import type { CloudSql } from "./database";

export async function countAttempts(
  sql: CloudSql,
  key: string,
  count = 1,
): Promise<number> {
  return (
    await sql.query<{ attempts: number }>(
      `INSERT INTO cloud_login_limits (key,attempts,expires_at) VALUES ($1,$2,now()+interval '1 minute')
      ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN cloud_login_limits.expires_at<=now() THEN $2 ELSE cloud_login_limits.attempts+$2 END,
      expires_at=CASE WHEN cloud_login_limits.expires_at<=now() THEN now()+interval '1 minute' ELSE cloud_login_limits.expires_at END RETURNING attempts`,
      [hashSecret(key), count],
    )
  ).rows[0]!.attempts;
}
