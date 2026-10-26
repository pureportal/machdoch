import { createRemoteTestDatabase } from "../test/remote-fixture";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { createSecret } from "./crypto";
import { FleetDatabase } from "./database";
import { FleetStore } from "./fleet-store";

let database: FleetDatabase | undefined;
afterEach(async () => await database?.close());

describe("enrollment grant lifecycle", () => {
  it("lists only usable metadata and atomically revokes keys and releases capacity", async () => {
    database = await createRemoteTestDatabase();
    const store = new FleetStore(database);
    const secret = createSecret("mch_enroll");
    const policy = { maximumOutstandingKeys: 1, keyLifetimeSeconds: 60 };
    const grant = await store.createEnrollmentGrant(secret, 100, policy);
    expect(await store.listEnrollmentGrants(100)).toEqual([grant]);
    expect(JSON.stringify(await store.listEnrollmentGrants(100))).not.toContain(
      secret,
    );
    await expect(
      async () =>
        await store.createEnrollmentGrant(
          createSecret("mch_enroll"),
          101,
          policy,
        ),
    ).rejects.toThrow("enrollment-limit");
    expect(await store.revokeEnrollmentGrant(grant.grantId, 102)).toBe(true);
    expect(await store.revokeEnrollmentGrant(grant.grantId, 103)).toBe(false);
    expect(await store.listEnrollmentGrants(103)).toEqual([]);
    await expect(
      async () => await store.enrollInstance(input(secret), 103),
    ).rejects.toThrow("invalid-enrollment-grant");
    expect(
      await database.all(
        "SELECT action FROM audit_log WHERE action = 'enrollment_key.revoked'",
      ),
    ).toHaveLength(1);
    expect(
      await store.createEnrollmentGrant(
        createSecret("mch_enroll"),
        103,
        policy,
      ),
    ).toHaveProperty("grantId");
  });

  it("excludes expired and consumed keys without revoking an enrolled instance", async () => {
    database = await createRemoteTestDatabase();
    const store = new FleetStore(database);
    const policy = { maximumOutstandingKeys: 8, keyLifetimeSeconds: 60 };
    const expired = await store.createEnrollmentGrant(
      createSecret("mch_enroll"),
      1,
      policy,
    );
    const secret = createSecret("mch_enroll");
    const consumed = await store.createEnrollmentGrant(secret, 50, policy);
    const enrollment = input(secret);
    const instance = await store.enrollInstance(enrollment, 51);
    expect(await store.listEnrollmentGrants(61)).toEqual([]);
    expect(await store.revokeEnrollmentGrant(expired.grantId, 61)).toBe(false);
    expect(await store.revokeEnrollmentGrant(consumed.grantId, 61)).toBe(false);
    await expect(
      async () => await store.enrollInstance(enrollment, 61),
    ).rejects.toThrow("invalid-enrollment-grant");
    expect(
      await store.authenticateInstance(
        instance.instanceId,
        enrollment.instanceSecret,
      ),
    ).toBe(true);
  });
});

function input(enrollmentKey: string) {
  return {
    enrollmentKey,
    instanceSecret: createSecret("mch_instance"),
    displayName: "Test",
    productVersion: "7.0.6",
    protocolVersion: gatewayProtocolVersion,
  };
}
