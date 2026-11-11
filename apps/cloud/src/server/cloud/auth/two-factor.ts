import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  AuthenticatorReplacement,
  AuthenticatorSetup,
  RecoveryCodes,
  TwoFactorStatus,
} from "../../../lib/cloud-two-factor-contract";
import {
  createSecret,
  hashSecret,
  validateSecret,
  verifySecret,
} from "../../crypto";
import type { SettingsCipher } from "../../settings-crypto";
import { CloudError, command, recordEvent, requireMembership } from "../access";
import { lockAdministration } from "../administration";
import { requireCredentialStorage } from "../credential-storage";
import type { CloudDatabase, CloudSql } from "../database";
import { capVerifiedSessions, lockUserSessions } from "../session-issuance";
import {
  createRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-codes";
import {
  createTotpSecret,
  encodeBase32,
  isTotpCode,
  matchTotp,
  totpUri,
} from "./totp";

const lockThreshold = 10;
const blockThreshold = 100;
const lockMinutes = 15;

interface SetupSession extends Record<string, unknown> {
  id: string;
  userId: string;
  organizationId: string;
  authenticator_setup: Uint8Array | null;
}
interface PendingSession extends SetupSession {
  csrf_hash: string;
  enrolled: boolean;
}
type CodeRejection =
  | { reason: "invalid" }
  | { reason: "locked"; minutes: number }
  | { reason: "blocked" };
type CodeCheck =
  | { ok: true; remainingRecoveryCodes: number | null }
  | ({ ok: false } & CodeRejection);
export interface SessionCredentials {
  sessionToken: string;
  csrfToken: string;
}

function authenticatorContext(userId: string): Buffer {
  return Buffer.from(`machdoch.cloud/authenticator/${userId}`);
}

function setupContext(sessionId: string): Buffer {
  return Buffer.from(`machdoch.cloud/authenticator-setup/${sessionId}`);
}

function compactCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

function signInAgain(): CloudError {
  return new CloudError(401, "authentication_required", "Sign in again.");
}

function alreadyEnabled(): CloudError {
  return new CloudError(
    409,
    "two_factor_enabled",
    "Two-factor authentication is already set up. Reload the page.",
  );
}

function codeRejected(
  rejection: CodeRejection,
  invalidMessage = "The code is incorrect. Try again.",
): CloudError {
  if (rejection.reason === "locked")
    return new CloudError(
      423,
      "two_factor_locked",
      `Too many incorrect codes. Try again in ${rejection.minutes === 1 ? "1 minute" : `${rejection.minutes} minutes`} or use a recovery code.`,
    );
  if (rejection.reason === "blocked")
    return new CloudError(
      423,
      "two_factor_blocked",
      "Too many incorrect codes. Use a recovery code or ask an administrator to reset two-factor authentication.",
    );
  return new CloudError(422, "invalid_code", invalidMessage);
}

async function pendingSession(
  sql: CloudSql,
  token: string,
  csrf: string,
): Promise<PendingSession> {
  if (!validateSecret(token, "mch_cloud_session")) throw signInAgain();
  const owner = (
    await sql.query<{ user_id: string }>(
      "SELECT user_id FROM cloud_sessions WHERE token_hash=$1",
      [hashSecret(token)],
    )
  ).rows[0];
  if (!owner) throw signInAgain();
  await lockUserSessions(sql, [owner.user_id]);
  const session = (
    await sql.query<PendingSession>(
      `SELECT s.id,s.user_id AS "userId",s.organization_id AS "organizationId",s.csrf_hash,s.authenticator_setup,
      EXISTS(SELECT 1 FROM cloud_authenticators a WHERE a.user_id=s.user_id) AS enrolled
      FROM cloud_sessions s WHERE s.token_hash=$1 AND s.second_factor_at IS NULL AND cloud_session_valid(s) FOR UPDATE OF s`,
      [hashSecret(token)],
    )
  ).rows[0];
  if (!session) throw signInAgain();
  if (
    !validateSecret(csrf, "mch_cloud_csrf") ||
    !verifySecret(csrf, session.csrf_hash)
  )
    throw new CloudError(
      403,
      "invalid_csrf",
      "Your request token expired. Reload the page and try again.",
    );
  return session;
}

async function accountSession(
  sql: CloudSql,
  actor: CloudActor,
  token: string,
): Promise<SetupSession> {
  if (actor.delegation)
    throw new CloudError(
      403,
      "browser_required",
      "Open Account in your browser to manage two-factor authentication.",
    );
  await requireMembership(sql, actor);
  await lockUserSessions(sql, [actor.userId]);
  const session = (
    await sql.query<SetupSession>(
      `SELECT s.id,s.user_id AS "userId",s.organization_id AS "organizationId",s.authenticator_setup FROM cloud_sessions s
      WHERE s.token_hash=$1 AND s.user_id=$2 AND s.organization_id=$3 AND cloud_session_active(s) FOR UPDATE OF s`,
      [hashSecret(token), actor.userId, actor.organizationId],
    )
  ).rows[0];
  if (!session) throw signInAgain();
  return session;
}

async function startSetup(
  sql: CloudSql,
  cipher: SettingsCipher,
  session: SetupSession,
): Promise<AuthenticatorSetup> {
  const secret = session.authenticator_setup
    ? cipher.decrypt(
        Buffer.from(session.authenticator_setup),
        setupContext(session.id),
      )
    : createTotpSecret();
  if (!session.authenticator_setup)
    await sql.query(
      "UPDATE cloud_sessions SET authenticator_setup=$2 WHERE id=$1",
      [session.id, cipher.encrypt(secret, setupContext(session.id))],
    );
  const label = (
    await sql.query<{ issuer: string; account: string }>(
      "SELECT o.name AS issuer,coalesce(u.email,u.login_name) AS account FROM cloud_organizations o,cloud_users u WHERE o.id=$1 AND u.id=$2",
      [session.organizationId, session.userId],
    )
  ).rows[0]!;
  return {
    secret: encodeBase32(secret),
    uri: totpUri(label.issuer, label.account, secret),
  };
}

function setupStep(
  cipher: SettingsCipher,
  session: SetupSession,
  code: string,
  invalidMessage: string,
): { secret: Buffer; step: number } {
  if (!session.authenticator_setup)
    throw new CloudError(
      409,
      "setup_required",
      "Scan the QR code again, then enter the new code.",
    );
  const secret = cipher.decrypt(
    Buffer.from(session.authenticator_setup),
    setupContext(session.id),
  );
  const step = matchTotp(secret, compactCode(code), 0);
  if (step === null)
    throw new CloudError(422, "invalid_setup_code", invalidMessage);
  return { secret, step };
}

async function checkCode(
  sql: CloudSql,
  cipher: SettingsCipher,
  userId: string,
  code: string,
): Promise<CodeCheck> {
  const authenticator = (
    await sql.query<{
      secret: Uint8Array;
      last_step: string;
      failed_attempts: number;
      lock_minutes: number | null;
    }>(
      `SELECT secret,last_step,failed_attempts,
      CASE WHEN failed_attempts>=$2 AND last_failed_at>clock_timestamp()-make_interval(mins=>$3)
        THEN ceil(extract(epoch FROM last_failed_at+make_interval(mins=>$3)-clock_timestamp())/60)::integer END AS lock_minutes
      FROM cloud_authenticators WHERE user_id=$1 FOR UPDATE`,
      [userId, lockThreshold, lockMinutes],
    )
  ).rows[0];
  if (!authenticator)
    throw new CloudError(
      409,
      "two_factor_setup_required",
      "Set up two-factor authentication to continue.",
    );
  const compact = compactCode(code);
  const authenticatorCode = isTotpCode(compact);
  const recoveryCode = authenticatorCode ? null : normalizeRecoveryCode(code);
  if (!authenticatorCode && !recoveryCode)
    throw new CloudError(
      422,
      "invalid_code_format",
      "Enter the 6-digit code from your authenticator app or a recovery code.",
    );
  if (authenticatorCode) {
    if (authenticator.failed_attempts >= blockThreshold)
      return { ok: false, reason: "blocked" };
    if (authenticator.lock_minutes !== null)
      return {
        ok: false,
        reason: "locked",
        minutes: authenticator.lock_minutes,
      };
    const step = matchTotp(
      cipher.decrypt(
        Buffer.from(authenticator.secret),
        authenticatorContext(userId),
      ),
      compact,
      Number(authenticator.last_step),
    );
    if (step !== null) {
      await sql.query(
        "UPDATE cloud_authenticators SET last_step=$2,failed_attempts=0,last_failed_at=NULL WHERE user_id=$1",
        [userId, step],
      );
      return { ok: true, remainingRecoveryCodes: null };
    }
  } else if (
    (
      await sql.query(
        "UPDATE cloud_recovery_codes SET used_at=clock_timestamp() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash",
        [userId, hashRecoveryCode(userId, recoveryCode!)],
      )
    ).rows.length
  ) {
    await sql.query(
      "UPDATE cloud_authenticators SET failed_attempts=0,last_failed_at=NULL WHERE user_id=$1",
      [userId],
    );
    return {
      ok: true,
      remainingRecoveryCodes: await remainingRecoveryCodes(sql, userId),
    };
  }
  await sql.query(
    "UPDATE cloud_authenticators SET failed_attempts=failed_attempts+1,last_failed_at=clock_timestamp() WHERE user_id=$1",
    [userId],
  );
  const failures = authenticator.failed_attempts + 1;
  if (failures >= blockThreshold) return { ok: false, reason: "blocked" };
  if (failures >= lockThreshold)
    return { ok: false, reason: "locked", minutes: lockMinutes };
  return { ok: false, reason: "invalid" };
}

async function remainingRecoveryCodes(
  sql: CloudSql,
  userId: string,
): Promise<number> {
  return (
    await sql.query<{ remaining: number }>(
      "SELECT count(*)::integer AS remaining FROM cloud_recovery_codes WHERE user_id=$1 AND used_at IS NULL",
      [userId],
    )
  ).rows[0]!.remaining;
}

async function replaceRecoveryCodes(
  sql: CloudSql,
  userId: string,
): Promise<string[]> {
  const codes = createRecoveryCodes();
  await sql.query("DELETE FROM cloud_recovery_codes WHERE user_id=$1", [
    userId,
  ]);
  await sql.query(
    "INSERT INTO cloud_recovery_codes (user_id,code_hash) SELECT $1,unnest($2::text[])",
    [
      userId,
      codes.map((code) =>
        hashRecoveryCode(userId, normalizeRecoveryCode(code)!),
      ),
    ],
  );
  return codes;
}

async function completeSecondFactor(
  sql: CloudSql,
  session: SetupSession,
): Promise<SessionCredentials> {
  const sessionToken = createSecret("mch_cloud_session"),
    csrfToken = createSecret("mch_cloud_csrf");
  await sql.query(
    "UPDATE cloud_sessions SET token_hash=$2,csrf_hash=$3,second_factor_at=clock_timestamp(),touched_at=clock_timestamp(),expires_at=clock_timestamp()+interval '12 hours',authenticator_setup=NULL WHERE id=$1",
    [session.id, hashSecret(sessionToken), hashSecret(csrfToken)],
  );
  await capVerifiedSessions(sql, session.userId, session.organizationId);
  return { sessionToken, csrfToken };
}

export class CloudTwoFactor {
  constructor(
    private readonly database: CloudDatabase,
    private readonly cipher: SettingsCipher | null,
  ) {}

  challenge(
    token: string,
  ): Promise<{ userId: string; enrolled: boolean } | null> {
    if (!validateSecret(token, "mch_cloud_session"))
      return Promise.resolve(null);
    return this.database.transaction(
      async (sql) =>
        (
          await sql.query<{ userId: string; enrolled: boolean }>(
            `SELECT s.user_id AS "userId",EXISTS(SELECT 1 FROM cloud_authenticators a WHERE a.user_id=s.user_id) AS enrolled
          FROM cloud_sessions s WHERE s.token_hash=$1 AND s.second_factor_at IS NULL AND cloud_session_valid(s)`,
            [hashSecret(token)],
          )
        ).rows[0] ?? null,
    );
  }

  setup(token: string, csrf: string): Promise<AuthenticatorSetup> {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const session = await pendingSession(sql, token, csrf);
      if (session.enrolled) throw alreadyEnabled();
      return startSetup(sql, cipher, session);
    });
  }

  confirmSetup(
    token: string,
    csrf: string,
    code: string,
  ): Promise<SessionCredentials & RecoveryCodes> {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const session = await pendingSession(sql, token, csrf);
      if (session.enrolled) throw alreadyEnabled();
      const { secret, step } = setupStep(
        cipher,
        session,
        code,
        "The code is incorrect. Enter the current code shown in your authenticator app.",
      );
      await sql.query(
        "INSERT INTO cloud_authenticators (user_id,secret,last_step) VALUES ($1,$2,$3)",
        [
          session.userId,
          cipher.encrypt(secret, authenticatorContext(session.userId)),
          step,
        ],
      );
      const recoveryCodes = await replaceRecoveryCodes(sql, session.userId);
      await recordEvent(
        sql,
        session,
        "two_factor.enabled",
        session.userId,
        1,
        {},
      );
      return {
        ...(await completeSecondFactor(sql, session)),
        recoveryCodes,
      };
    });
  }

  async verify(
    token: string,
    csrf: string,
    code: string,
  ): Promise<SessionCredentials & { remainingRecoveryCodes: number | null }> {
    const outcome = await this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const session = await pendingSession(sql, token, csrf);
      const check = await checkCode(sql, cipher, session.userId, code);
      if (!check.ok) return check;
      if (check.remainingRecoveryCodes !== null)
        await recordEvent(
          sql,
          session,
          "two_factor.recovery_code_used",
          session.userId,
          1,
          { remaining: check.remainingRecoveryCodes },
        );
      return {
        ok: true as const,
        credentials: await completeSecondFactor(sql, session),
        remainingRecoveryCodes: check.remainingRecoveryCodes,
      };
    });
    if (!outcome.ok) throw codeRejected(outcome);
    return {
      ...outcome.credentials,
      remainingRecoveryCodes: outcome.remainingRecoveryCodes,
    };
  }

  status(actor: CloudActor): Promise<TwoFactorStatus> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
      const row = (
        await sql.query<{ createdAt: Date }>(
          'SELECT created_at AS "createdAt" FROM cloud_authenticators WHERE user_id=$1',
          [actor.userId],
        )
      ).rows[0];
      if (!row) throw signInAgain();
      return {
        createdAt: row.createdAt.toISOString(),
        recoveryCodes: await remainingRecoveryCodes(sql, actor.userId),
      };
    });
  }

  beginReplacement(
    actor: CloudActor,
    token: string,
  ): Promise<AuthenticatorSetup> {
    return this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      return startSetup(sql, cipher, await accountSession(sql, actor, token));
    });
  }

  async replace(
    actor: CloudActor,
    token: string,
    input: AuthenticatorReplacement,
  ): Promise<void> {
    const outcome = await this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      const session = await accountSession(sql, actor, token);
      const replacement = setupStep(
        cipher,
        session,
        input.code,
        "The code from the new app is incorrect.",
      );
      const check = await checkCode(
        sql,
        cipher,
        actor.userId,
        input.currentCode,
      );
      if (!check.ok) return check;
      await sql.query(
        "UPDATE cloud_authenticators SET secret=$2,last_step=$3,failed_attempts=0,created_at=clock_timestamp() WHERE user_id=$1",
        [
          actor.userId,
          cipher.encrypt(
            replacement.secret,
            authenticatorContext(actor.userId),
          ),
          replacement.step,
        ],
      );
      await sql.query(
        "DELETE FROM cloud_sessions WHERE user_id=$1 AND id<>$2",
        [actor.userId, session.id],
      );
      await sql.query(
        "UPDATE cloud_sessions SET authenticator_setup=NULL WHERE id=$1",
        [session.id],
      );
      await recordEvent(sql, actor, "two_factor.replaced", actor.userId, 1, {});
      return { ok: true as const };
    });
    if (!outcome.ok)
      throw codeRejected(
        outcome,
        "The current code or recovery code is incorrect.",
      );
  }

  async regenerateRecoveryCodes(
    actor: CloudActor,
    token: string,
    code: string,
  ): Promise<RecoveryCodes> {
    const outcome = await this.database.transaction(async (sql) => {
      const cipher = await requireCredentialStorage(sql, this.cipher);
      await accountSession(sql, actor, token);
      const check = await checkCode(sql, cipher, actor.userId, code);
      if (!check.ok) return check;
      const recoveryCodes = await replaceRecoveryCodes(sql, actor.userId);
      await recordEvent(
        sql,
        actor,
        "two_factor.recovery_codes_replaced",
        actor.userId,
        1,
        {},
      );
      return { ok: true as const, recoveryCodes };
    });
    if (!outcome.ok) throw codeRejected(outcome);
    return { recoveryCodes: outcome.recoveryCodes };
  }

  resetMember(
    actor: CloudActor,
    key: string,
    userId: string,
  ): Promise<{ id: string }> {
    return this.database.transaction(async (sql) => {
      const role = await lockAdministration(sql, actor);
      return command(
        sql,
        actor,
        key,
        { kind: "member.two_factor_reset", userId },
        async () => {
          if (userId === actor.userId)
            throw new CloudError(
              409,
              "own_two_factor",
              "Manage your own two-factor authentication in Account.",
            );
          const target = (
            await sql.query<{ role: string }>(
              "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
              [actor.organizationId, userId],
            )
          ).rows[0];
          if (!target)
            throw new CloudError(404, "not_found", "Member is unavailable.");
          if (role !== "owner" && ["owner", "admin"].includes(target.role))
            throw new CloudError(
              403,
              "owner_required",
              "Only an owner can reset two-factor authentication for administrators and owners.",
            );
          if (
            (
              await sql.query(
                "SELECT 1 FROM cloud_memberships WHERE user_id=$1 AND organization_id<>$2 AND active",
                [userId, actor.organizationId],
              )
            ).rows.length
          )
            throw new CloudError(
              409,
              "shared_account",
              "This account also belongs to another organization. Its two-factor authentication cannot be reset here.",
            );
          await lockUserSessions(sql, [userId]);
          await sql.query("DELETE FROM cloud_authenticators WHERE user_id=$1", [
            userId,
          ]);
          await sql.query("DELETE FROM cloud_recovery_codes WHERE user_id=$1", [
            userId,
          ]);
          await sql.query("DELETE FROM cloud_sessions WHERE user_id=$1", [
            userId,
          ]);
          await sql.query(
            "UPDATE cloud_oauth_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
            [userId],
          );
          await recordEvent(
            sql,
            actor,
            "member.two_factor_reset",
            userId,
            1,
            {},
          );
          return { id: userId };
        },
      );
    });
  }
}
