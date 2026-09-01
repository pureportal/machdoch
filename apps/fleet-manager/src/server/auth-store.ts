import type { FleetManagerConfig } from "./config";
import {
  CredentialValidationError,
  createId,
  hashOwnerPassword,
  hashOwnerPasswordAsync,
  hashSecret,
  validateOwnerPassword,
  verifyOwnerPassword,
  verifySecret,
} from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
  nowSeconds,
  requiredNumber,
  requiredString,
} from "./database";

export interface AuthenticatedSession {
  username: string;
  sessionId: string;
  sessionHash: string;
}

export interface OwnerSession {
  sessionId: string;
  clientLabel: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}

export interface OwnerAccount {
  username: string;
  createdAt: number;
  updatedAt: number;
}

export type OwnerAccountChangeResult =
  | "changed"
  | "incorrect-password"
  | "stale";

export class AuthStore {
  constructor(private readonly database: FleetDatabase) {}

  ownerExists(): boolean {
    return Boolean(this.database.get("SELECT id FROM owner WHERE id = 1"));
  }

  ownerAccount(): OwnerAccount {
    const row = this.database.get(
      "SELECT username, created_at, updated_at FROM owner WHERE id = 1",
    );
    return {
      username: requiredString(row, "username"),
      createdAt: requiredNumber(row, "created_at"),
      updatedAt: requiredNumber(row, "updated_at"),
    };
  }

  seedOwner(username: string, password: string, now: number): void {
    const normalizedUsername = normalizeUsername(username);
    const passwordHash = hashOwnerPassword(password);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO owner (id, username, password_hash, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           username = excluded.username,
           password_hash = excluded.password_hash,
           updated_at = excluded.updated_at`,
        normalizedUsername,
        passwordHash,
        now,
        now,
      );
      this.database.run("DELETE FROM owner_sessions");
      this.database.audit(now, "owner.seeded", normalizedUsername, "success");
    });
  }

  changeOwnerPassword(username: string, password: string, now: number): void {
    const normalizedUsername = normalizeUsername(username);
    const passwordHash = hashOwnerPassword(password);
    this.database.transaction(() => {
      const updated = this.database.run(
        "UPDATE owner SET username = ?, password_hash = ?, updated_at = ? WHERE id = 1",
        normalizedUsername,
        passwordHash,
        now,
      );
      if (updated !== 1)
        throw new Error("Fleet Manager has not been initialized.");
      this.database.run("DELETE FROM owner_sessions");
      this.database.audit(
        now,
        "owner.password_changed",
        normalizedUsername,
        "success",
      );
    });
  }

  async createOwnerSessionForCredentials(
    username: string,
    password: string,
    sessionToken: string,
    csrfToken: string,
    clientLabel: string,
    now: number,
    policy: FleetManagerConfig["sessionPolicy"],
  ): Promise<boolean> {
    const normalizedUsername = username.trim();
    const row = this.database.get(
      "SELECT username, password_hash FROM owner WHERE id = 1",
    );
    const storedUsername =
      typeof row?.username === "string" ? row.username : null;
    const expectedPasswordHash =
      typeof row?.password_hash === "string" ? row.password_hash : null;
    const authenticated = Boolean(
      storedUsername &&
      expectedPasswordHash &&
      (await verifyOwnerPassword(password, expectedPasswordHash)) &&
      verifySecret(normalizedUsername, hashSecret(storedUsername)),
    );
    if (!authenticated || !storedUsername || !expectedPasswordHash) {
      this.auditLogin(now, normalizedUsername, false);
      return false;
    }
    const sessionId = createId("session");
    const idleExpiresAt = now + policy.idleSeconds;
    const absoluteExpiresAt = now + policy.absoluteSeconds;
    return this.database.transaction(() => {
      const ownerIsCurrent = Boolean(
        this.database.get(
          "SELECT id FROM owner WHERE id = 1 AND username = ? AND password_hash = ?",
          storedUsername,
          expectedPasswordHash,
        ),
      );
      if (!ownerIsCurrent) {
        this.auditLogin(now, normalizedUsername, false);
        return false;
      }
      this.pruneSessions(now);
      const count = requiredNumber(
        this.database.get("SELECT COUNT(*) AS count FROM owner_sessions"),
        "count",
      );
      const removeCount = Math.max(
        0,
        count + 1 - policy.maximumConcurrentSessions,
      );
      if (removeCount > 0) {
        this.database.run(
          `DELETE FROM owner_sessions WHERE session_id IN (
             SELECT session_id FROM owner_sessions ORDER BY last_seen_at ASC LIMIT ?
           )`,
          removeCount,
        );
      }
      this.database.run(
        `INSERT INTO owner_sessions
         (session_id, session_hash, csrf_hash, username, client_label, created_at,
          last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        hashSecret(sessionToken),
        hashSecret(csrfToken),
        storedUsername,
        clientLabel,
        now,
        now,
        idleExpiresAt,
        absoluteExpiresAt,
      );
      this.auditLogin(now, storedUsername, true);
      return true;
    });
  }

  async changeOwnerAccountForSession(
    session: AuthenticatedSession,
    currentPassword: string,
    username: string,
    newPassword: string,
    now: number,
  ): Promise<OwnerAccountChangeResult> {
    const normalizedUsername = normalizeUsername(username);
    validateOwnerPassword(newPassword);
    const row = this.database.get(
      "SELECT username, password_hash FROM owner WHERE id = 1",
    );
    const storedUsername =
      typeof row?.username === "string" ? row.username : null;
    const expectedPasswordHash =
      typeof row?.password_hash === "string" ? row.password_hash : null;
    const authenticated = Boolean(
      storedUsername &&
      expectedPasswordHash &&
      verifySecret(session.username, hashSecret(storedUsername)) &&
      (await verifyOwnerPassword(currentPassword, expectedPasswordHash)),
    );
    if (!authenticated || !expectedPasswordHash) {
      this.database.audit(
        now,
        "owner.password_confirmation_failed",
        session.sessionId,
        "denied",
      );
      return "incorrect-password";
    }
    const passwordHash = await hashOwnerPasswordAsync(newPassword);
    const changedAt = nowSeconds();
    return this.database.transaction(() => {
      const updated = this.database.run(
        `UPDATE owner SET username = ?, password_hash = ?, updated_at = ?
         WHERE id = 1 AND password_hash = ?
           AND EXISTS (
             SELECT 1 FROM owner_sessions
             WHERE session_hash = ?
               AND idle_expires_at > ?
               AND absolute_expires_at > ?
           )`,
        normalizedUsername,
        passwordHash,
        changedAt,
        expectedPasswordHash,
        session.sessionHash,
        changedAt,
        changedAt,
      );
      if (updated !== 1) {
        this.database.audit(
          changedAt,
          "owner.password_change",
          session.sessionId,
          "conflict",
        );
        return "stale";
      }
      this.database.run("DELETE FROM owner_sessions");
      this.database.audit(
        changedAt,
        "owner.password_changed",
        normalizedUsername,
        "success",
      );
      return "changed";
    });
  }

  authenticateSession(
    sessionToken: string,
    now: number,
    idleSeconds: number,
  ): AuthenticatedSession | null {
    const sessionHash = hashSecret(sessionToken);
    return this.database.transaction(() => {
      const row = this.database.get(
        `SELECT username, session_id, idle_expires_at, absolute_expires_at
         FROM owner_sessions WHERE session_hash = ?`,
        sessionHash,
      );
      if (!row) return null;
      const idleExpiresAt = requiredNumber(row, "idle_expires_at");
      const absoluteExpiresAt = requiredNumber(row, "absolute_expires_at");
      if (idleExpiresAt <= now || absoluteExpiresAt <= now) {
        this.database.run(
          "DELETE FROM owner_sessions WHERE session_hash = ?",
          sessionHash,
        );
        return null;
      }
      this.database.run(
        "UPDATE owner_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE session_hash = ?",
        now,
        Math.min(now + idleSeconds, absoluteExpiresAt),
        sessionHash,
      );
      return {
        username: requiredString(row, "username"),
        sessionId: requiredString(row, "session_id"),
        sessionHash,
      };
    });
  }

  listOwnerSessions(now: number): OwnerSession[] {
    this.pruneSessions(now);
    return this.database
      .all(
        `SELECT session_id, client_label, created_at, last_seen_at,
                idle_expires_at, absolute_expires_at
         FROM owner_sessions ORDER BY last_seen_at DESC, created_at DESC`,
      )
      .map(ownerSessionFromRow);
  }

  verifySessionCsrf(sessionHash: string, csrfToken: string): boolean {
    const row = this.database.get(
      "SELECT csrf_hash FROM owner_sessions WHERE session_hash = ?",
      sessionHash,
    );
    return (
      typeof row?.csrf_hash === "string" &&
      verifySecret(csrfToken, row.csrf_hash)
    );
  }

  revokeSessionByHash(sessionHash: string, now: number): void {
    const row = this.database.get(
      "SELECT session_id FROM owner_sessions WHERE session_hash = ?",
      sessionHash,
    );
    this.database.transaction(() => {
      this.database.run(
        "DELETE FROM owner_sessions WHERE session_hash = ?",
        sessionHash,
      );
      this.database.audit(
        now,
        "owner.logout",
        typeof row?.session_id === "string" ? row.session_id : null,
        "success",
      );
    });
  }

  revokeSessionById(sessionId: string, now: number): boolean {
    return this.database.transaction(() => {
      const revoked = this.database.run(
        "DELETE FROM owner_sessions WHERE session_id = ?",
        sessionId,
      );
      if (revoked === 1) {
        this.database.audit(now, "owner.session_revoked", sessionId, "success");
      }
      return revoked === 1;
    });
  }

  private pruneSessions(now: number): void {
    this.database.run(
      "DELETE FROM owner_sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?",
      now,
      now,
    );
  }

  private auditLogin(
    now: number,
    username: string,
    authenticated: boolean,
  ): void {
    this.database.audit(
      now,
      authenticated ? "owner.login" : "owner.login_failed",
      [...username].slice(0, 64).join(""),
      authenticated ? "success" : "denied",
    );
  }
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();
  if (!normalized || [...normalized].length > 64) {
    throw new CredentialValidationError(
      "Username must contain between 1 and 64 characters.",
    );
  }
  if (/[\p{Cc}\p{Cf}]/u.test(normalized))
    throw new CredentialValidationError(
      "Username contains unsupported characters.",
    );
  return normalized;
}

function ownerSessionFromRow(row: DatabaseRow): OwnerSession {
  return {
    sessionId: requiredString(row, "session_id"),
    clientLabel: requiredString(row, "client_label"),
    createdAt: requiredNumber(row, "created_at"),
    lastSeenAt: requiredNumber(row, "last_seen_at"),
    idleExpiresAt: requiredNumber(row, "idle_expires_at"),
    absoluteExpiresAt: requiredNumber(row, "absolute_expires_at"),
  };
}
