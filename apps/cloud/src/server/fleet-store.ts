import { createHash } from "node:crypto";
import type { AgentAccess, AgentAccessInput } from "../lib/client-access";
import type { CloudServerConfig } from "./config";
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
  ownerUserId: string | null;
  ownerName: string | null;
  agentAccess: AgentAccess;
  agentUsers: string[];
}

export interface EnrollmentInput {
  enrollmentKey: string;
  codeVerifier?: string;
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

const signInGrantLifetimeSeconds = 300;
const instanceColumns = `i.instance_id, i.display_name, i.product_version, i.protocol_version,
  i.enrolled_at, i.last_seen_at, i.revoked_at, i.owner_user_id::text AS owner_user_id,
  u.name AS owner_name, i.agent_access, i.agent_users::text[] AS agent_users
  FROM instances i LEFT JOIN public.cloud_users u ON u.id = i.owner_user_id`;

export class FleetStoreError extends Error {
  constructor(readonly code: "enrollment-limit" | "invalid-enrollment-grant") {
    super(code);
  }
}

export class FleetStore {
  constructor(private readonly database: FleetDatabase) {}

  async createEnrollmentGrant(
    enrollmentKey: string,
    now: number,
    policy: CloudServerConfig["enrollmentPolicy"],
  ): Promise<EnrollmentGrant> {
    return await this.database.transaction(async () => {
      await this.database.run(
        "UPDATE enrollment_grants SET used_at = $1 WHERE used_at IS NULL AND expires_at <= $2",
        now,
        now,
      );
      const outstanding = requiredNumber(
        await this.database.get(
          "SELECT COUNT(*)::integer AS count FROM enrollment_grants WHERE used_at IS NULL AND expires_at > $1 AND challenge IS NULL",
          now,
        ),
        "count",
      );
      if (outstanding >= policy.maximumOutstandingKeys) {
        throw new FleetStoreError("enrollment-limit");
      }
      const grantId = createId("grant");
      const expiresAt = now + policy.keyLifetimeSeconds;
      await this.database.run(
        "INSERT INTO enrollment_grants (id, key_hash, created_at, expires_at)\n         VALUES ($1, $2, $3, $4)",
        grantId,
        hashSecret(enrollmentKey),
        now,
        expiresAt,
      );
      await this.database.audit(
        now,
        "enrollment_key.created",
        grantId,
        "success",
      );
      return { grantId, createdAt: now, expiresAt };
    });
  }

  async createSignInGrant(
    enrollmentKey: string,
    challenge: string,
    ownerUserId: string | null,
    now: number,
  ): Promise<void> {
    await this.database.transaction(async () => {
      const grantId = createId("grant");
      await this.database.run(
        "INSERT INTO enrollment_grants (id, key_hash, created_at, expires_at, challenge, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
        grantId,
        hashSecret(enrollmentKey),
        now,
        now + signInGrantLifetimeSeconds,
        challenge,
        ownerUserId,
      );
      await this.database.audit(now, "sign_in.approved", grantId, "success");
    });
  }

  async listEnrollmentGrants(now: number): Promise<EnrollmentGrant[]> {
    // Return metadata only. Enrollment secrets are never recoverable from this inventory.
    return (
      await this.database.all(
        "SELECT id, created_at, expires_at FROM enrollment_grants\n       WHERE used_at IS NULL AND expires_at > $1 AND challenge IS NULL ORDER BY created_at DESC, id",
        now,
      )
    ).map((row) => ({
      grantId: requiredString(row, "id"),
      createdAt: requiredNumber(row, "created_at"),
      expiresAt: requiredNumber(row, "expires_at"),
    }));
  }

  async revokeEnrollmentGrant(grantId: string, now: number): Promise<boolean> {
    return await this.database.transaction(async () => {
      // Consuming a grant invalidates it atomically against enrollment and releases its slot.
      const updated = await this.database.run(
        "UPDATE enrollment_grants SET used_at = $1 WHERE id = $2 AND used_at IS NULL AND expires_at > $3",
        now,
        grantId,
        now,
      );
      if (updated === 1)
        await this.database.audit(
          now,
          "enrollment_key.revoked",
          grantId,
          "success",
        );
      return updated === 1;
    });
  }

  async enrollInstance(
    input: EnrollmentInput,
    now: number,
  ): Promise<FleetInstance> {
    return await this.database.transaction(async () => {
      const keyHash = hashSecret(input.enrollmentKey);
      const grant = await this.database.get(
        "SELECT id, expires_at, used_at, challenge, owner_user_id::text AS owner_user_id FROM enrollment_grants WHERE key_hash = $1",
        keyHash,
      );
      if (
        !grant ||
        grant.used_at !== null ||
        requiredNumber(grant, "expires_at") <= now ||
        !verifierMatches(grant.challenge, input.codeVerifier)
      ) {
        throw new FleetStoreError("invalid-enrollment-grant");
      }
      const grantId = requiredString(grant, "id");
      if (
        (await this.database.run(
          "UPDATE enrollment_grants SET used_at = $1 WHERE id = $2 AND used_at IS NULL",
          now,
          grantId,
        )) !== 1
      ) {
        throw new FleetStoreError("invalid-enrollment-grant");
      }
      const instanceId = createId("instance");
      await this.database.run(
        "INSERT INTO instances\n         (instance_id, display_name, secret_hash, product_version, protocol_version, enrolled_at, owner_user_id)\n         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        instanceId,
        input.displayName,
        hashSecret(input.instanceSecret),
        input.productVersion,
        input.protocolVersion,
        now,
        optionalString(grant, "owner_user_id"),
      );
      await this.database.audit(
        now,
        "instance.enrolled",
        instanceId,
        "success",
      );
      const instance = await this.getInstance(instanceId);
      if (!instance) throw new Error("Enrolled instance could not be read.");
      return instance;
    });
  }

  async listInstances(): Promise<FleetInstance[]> {
    return (
      await this.database.all(
        `SELECT ${instanceColumns} ORDER BY lower(i.display_name), i.enrolled_at`,
      )
    ).map(instanceFromRow);
  }

  async getInstance(instanceId: string): Promise<FleetInstance | null> {
    const row = await this.database.get(
      `SELECT ${instanceColumns} WHERE i.instance_id = $1`,
      instanceId,
    );
    return row ? instanceFromRow(row) : null;
  }

  async authenticateInstance(
    instanceId: string,
    secret: string,
  ): Promise<boolean> {
    const row = await this.database.get(
      "SELECT secret_hash FROM instances WHERE instance_id = $1 AND revoked_at IS NULL",
      instanceId,
    );
    return (
      typeof row?.secret_hash === "string" &&
      verifySecret(secret, row.secret_hash)
    );
  }

  async updateInstancePresence(
    instanceId: string,
    productVersion: string,
    protocolVersion: number,
    now: number,
  ): Promise<void> {
    const updated = await this.database.run(
      "UPDATE instances SET product_version = $1, protocol_version = $2, last_seen_at = $3\n       WHERE instance_id = $4 AND revoked_at IS NULL",
      productVersion,
      protocolVersion,
      now,
      instanceId,
    );
    if (updated !== 1)
      throw new Error("Instance is not enrolled or has been revoked.");
  }

  async setAgentAccess(
    instanceId: string,
    access: AgentAccessInput,
    now: number,
  ): Promise<boolean> {
    const updated = await this.database.run(
      "UPDATE instances SET agent_access = $1, agent_users = $2::uuid[] WHERE instance_id = $3 AND owner_user_id IS NULL AND revoked_at IS NULL",
      access.agentAccess,
      access.agentAccess === "people" ? [...new Set(access.agentUsers)] : [],
      instanceId,
    );
    if (updated === 1)
      await this.database.audit(
        now,
        `instance.agent_access.${access.agentAccess}`,
        instanceId,
        "success",
      );
    return updated === 1;
  }

  async revokeInstance(instanceId: string, now: number): Promise<boolean> {
    const updated = await this.database.run(
      "UPDATE instances SET revoked_at = $1 WHERE instance_id = $2 AND revoked_at IS NULL",
      now,
      instanceId,
    );
    if (updated === 1)
      await this.database.audit(now, "instance.revoked", instanceId, "success");
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
    ownerUserId: optionalString(row, "owner_user_id"),
    ownerName: optionalString(row, "owner_name"),
    agentAccess: requiredString(row, "agent_access") as AgentAccess,
    agentUsers: row.agent_users as string[],
  };
}

function verifierMatches(
  challenge: unknown,
  verifier: string | undefined,
): boolean {
  if (challenge === null) return verifier === undefined;
  return (
    typeof challenge === "string" &&
    verifier !== undefined &&
    createHash("sha256").update(verifier).digest("base64url") === challenge
  );
}

function optionalString(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string")
    throw new Error(`Database field ${key} is invalid.`);
  return value;
}
