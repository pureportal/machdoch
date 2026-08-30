import type { FleetManagerConfig } from "./config";
import {
  createId,
  hashOwnerPassword,
  hashSecret,
  verifyOwnerPassword,
  verifySecret,
} from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
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
    const passwordHash = hashOwnerPassword(password, 8);
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

  verifyOwner(username: string, password: string, now: number): boolean {
    const normalizedUsername = username.trim();
    const row = this.database.get(
      "SELECT username, password_hash FROM owner WHERE id = 1",
    );
    const authenticated =
      typeof row?.username === "string" &&
      typeof row.password_hash === "string" &&
      row.username === normalizedUsername &&
      verifyOwnerPassword(password, row.password_hash);
    this.database.audit(
      now,
      authenticated ? "owner.login" : "owner.login_failed",
      normalizedUsername.slice(0, 64),
      authenticated ? "success" : "denied",
    );
    return authenticated;
  }

  createOwnerSession(
    username: string,
    sessionToken: string,
    csrfToken: string,
    clientLabel: string,
    now: number,
    policy: FleetManagerConfig["sessionPolicy"],
  ): string {
    const sessionId = createId("session");
    const idleExpiresAt = now + policy.idleSeconds;
    const absoluteExpiresAt = now + policy.absoluteSeconds;
    this.database.transaction(() => {
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
        username.trim(),
        clientLabel,
        now,
        now,
        idleExpiresAt,
        absoluteExpiresAt,
      );
    });
    return sessionId;
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
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();
  if (!normalized || [...normalized].length > 64) {
    throw new Error("Username must contain between 1 and 64 characters.");
  }
  if (/\p{Cc}/u.test(normalized))
    throw new Error("Username contains unsupported characters.");
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
