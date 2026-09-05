import type { FleetManagerConfig } from "./config";
import { createId, hashSecret, verifySecret } from "./crypto";
import {
  type DatabaseRow,
  type FleetDatabase,
  optionalNumber,
  requiredNumber,
  requiredString,
} from "./database";

export interface FleetInstance {
  instanceId: string;
  displayName: string;
  productVersion: string;
  protocolVersion: number;
  enrolledAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface EnrollmentInput {
  enrollmentKey: string;
  instanceSecret: string;
  displayName: string;
  productVersion: string;
  protocolVersion: number;
}

export interface EnrollmentGrant {
  grantId: string;
  createdAt: number;
  expiresAt: number;
}

export class FleetStoreError extends Error {
  constructor(readonly code: "enrollment-limit" | "invalid-enrollment-grant") {
    super(code);
  }
}

export class FleetStore {
  constructor(private readonly database: FleetDatabase) {}

  createEnrollmentGrant(
    enrollmentKey: string,
    now: number,
    policy: FleetManagerConfig["enrollmentPolicy"],
  ): EnrollmentGrant {
    return this.database.transaction(() => {
      this.database.run(
        "UPDATE enrollment_grants SET used_at = ? WHERE used_at IS NULL AND expires_at <= ?",
        now,
        now,
      );
      const outstanding = requiredNumber(
        this.database.get(
          "SELECT COUNT(*) AS count FROM enrollment_grants WHERE used_at IS NULL AND expires_at > ?",
          now,
        ),
        "count",
      );
      if (outstanding >= policy.maximumOutstandingKeys) {
        throw new FleetStoreError("enrollment-limit");
      }
      const grantId = createId("grant");
      const expiresAt = now + policy.keyLifetimeSeconds;
      this.database.run(
        `INSERT INTO enrollment_grants (id, key_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
        grantId,
        hashSecret(enrollmentKey),
        now,
        expiresAt,
      );
      this.database.audit(now, "enrollment_key.created", grantId, "success");
      return { grantId, createdAt: now, expiresAt };
    });
  }

  listEnrollmentGrants(now: number): EnrollmentGrant[] {
    // Return metadata only. Enrollment secrets are never recoverable from this inventory.
    return this.database
      .all(
        `SELECT id, created_at, expires_at FROM enrollment_grants
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id`,
        now,
      )
      .map((row) => ({
        grantId: requiredString(row, "id"),
        createdAt: requiredNumber(row, "created_at"),
        expiresAt: requiredNumber(row, "expires_at"),
      }));
  }

  revokeEnrollmentGrant(grantId: string, now: number): boolean {
    return this.database.transaction(() => {
      // Consuming a grant invalidates it atomically against enrollment and releases its slot.
      const updated = this.database.run(
        "UPDATE enrollment_grants SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
        now,
        grantId,
        now,
      );
      if (updated === 1)
        this.database.audit(now, "enrollment_key.revoked", grantId, "success");
      return updated === 1;
    });
  }

  enrollInstance(input: EnrollmentInput, now: number): FleetInstance {
    return this.database.transaction(() => {
      const keyHash = hashSecret(input.enrollmentKey);
      const grant = this.database.get(
        "SELECT id, expires_at, used_at FROM enrollment_grants WHERE key_hash = ?",
        keyHash,
      );
      if (
        !grant ||
        grant.used_at !== null ||
        requiredNumber(grant, "expires_at") <= now
      ) {
        throw new FleetStoreError("invalid-enrollment-grant");
      }
      const grantId = requiredString(grant, "id");
      if (
        this.database.run(
          "UPDATE enrollment_grants SET used_at = ? WHERE id = ? AND used_at IS NULL",
          now,
          grantId,
        ) !== 1
      ) {
        throw new FleetStoreError("invalid-enrollment-grant");
      }
      const instanceId = createId("instance");
      this.database.run(
        `INSERT INTO instances
         (instance_id, display_name, secret_hash, product_version, protocol_version, enrolled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        instanceId,
        input.displayName,
        hashSecret(input.instanceSecret),
        input.productVersion,
        input.protocolVersion,
        now,
      );
      this.database.audit(now, "instance.enrolled", instanceId, "success");
      return {
        instanceId,
        displayName: input.displayName,
        productVersion: input.productVersion,
        protocolVersion: input.protocolVersion,
        enrolledAt: now,
        lastSeenAt: null,
        revokedAt: null,
      };
    });
  }

  listInstances(): FleetInstance[] {
    return this.database
      .all(
        `SELECT instance_id, display_name, product_version, protocol_version,
                enrolled_at, last_seen_at, revoked_at
         FROM instances ORDER BY display_name COLLATE NOCASE, enrolled_at`,
      )
      .map(instanceFromRow);
  }

  getInstance(instanceId: string): FleetInstance | null {
    const row = this.database.get(
      `SELECT instance_id, display_name, product_version, protocol_version,
              enrolled_at, last_seen_at, revoked_at
       FROM instances WHERE instance_id = ?`,
      instanceId,
    );
    return row ? instanceFromRow(row) : null;
  }

  authenticateInstance(instanceId: string, secret: string): boolean {
    const row = this.database.get(
      "SELECT secret_hash FROM instances WHERE instance_id = ? AND revoked_at IS NULL",
      instanceId,
    );
    return (
      typeof row?.secret_hash === "string" &&
      verifySecret(secret, row.secret_hash)
    );
  }

  updateInstancePresence(
    instanceId: string,
    productVersion: string,
    protocolVersion: number,
    now: number,
  ): void {
    const updated = this.database.run(
      `UPDATE instances SET product_version = ?, protocol_version = ?, last_seen_at = ?
       WHERE instance_id = ? AND revoked_at IS NULL`,
      productVersion,
      protocolVersion,
      now,
      instanceId,
    );
    if (updated !== 1)
      throw new Error("Instance is not enrolled or has been revoked.");
  }

  revokeInstance(instanceId: string, now: number): boolean {
    const updated = this.database.run(
      "UPDATE instances SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL",
      now,
      instanceId,
    );
    if (updated === 1)
      this.database.audit(now, "instance.revoked", instanceId, "success");
    return updated === 1;
  }
}

function instanceFromRow(row: DatabaseRow): FleetInstance {
  return {
    instanceId: requiredString(row, "instance_id"),
    displayName: requiredString(row, "display_name"),
    productVersion: requiredString(row, "product_version"),
    protocolVersion: requiredNumber(row, "protocol_version"),
    enrolledAt: requiredNumber(row, "enrolled_at"),
    lastSeenAt: optionalNumber(row, "last_seen_at"),
    revokedAt: optionalNumber(row, "revoked_at"),
  };
}
