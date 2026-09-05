import { afterEach, describe, expect, it } from "vitest";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { createSecret } from "./crypto";
import { FleetDatabase } from "./database";
import { FleetStore } from "./fleet-store";

let database: FleetDatabase | undefined;
afterEach(() => database?.close());

describe("enrollment grant lifecycle", () => {
  it("lists only usable metadata and atomically revokes keys and releases capacity", () => {
    database = new FleetDatabase(":memory:");
    const store = new FleetStore(database);
    const secret = createSecret("mch_enroll");
    const policy = { maximumOutstandingKeys: 1, keyLifetimeSeconds: 60 };
    const grant = store.createEnrollmentGrant(secret, 100, policy);
    expect(store.listEnrollmentGrants(100)).toEqual([grant]);
    expect(JSON.stringify(store.listEnrollmentGrants(100))).not.toContain(
      secret,
    );
    expect(() =>
      store.createEnrollmentGrant(createSecret("mch_enroll"), 101, policy),
    ).toThrow("enrollment-limit");
    expect(store.revokeEnrollmentGrant(grant.grantId, 102)).toBe(true);
    expect(store.revokeEnrollmentGrant(grant.grantId, 103)).toBe(false);
    expect(store.listEnrollmentGrants(103)).toEqual([]);
    expect(() => store.enrollInstance(input(secret), 103)).toThrow(
      "invalid-enrollment-grant",
    );
    expect(
      database.all(
        "SELECT action FROM audit_log WHERE action = 'enrollment_key.revoked'",
      ),
    ).toHaveLength(1);
    expect(() =>
      store.createEnrollmentGrant(createSecret("mch_enroll"), 103, policy),
    ).not.toThrow();
  });

  it("excludes expired and consumed keys without revoking an enrolled instance", () => {
    database = new FleetDatabase(":memory:");
    const store = new FleetStore(database);
    const policy = { maximumOutstandingKeys: 8, keyLifetimeSeconds: 60 };
    const expired = store.createEnrollmentGrant(
      createSecret("mch_enroll"),
      1,
      policy,
    );
    const secret = createSecret("mch_enroll");
    const consumed = store.createEnrollmentGrant(secret, 50, policy);
    const enrollment = input(secret);
    const instance = store.enrollInstance(enrollment, 51);
    expect(store.listEnrollmentGrants(61)).toEqual([]);
    expect(store.revokeEnrollmentGrant(expired.grantId, 61)).toBe(false);
    expect(store.revokeEnrollmentGrant(consumed.grantId, 61)).toBe(false);
    expect(() => store.enrollInstance(enrollment, 61)).toThrow(
      "invalid-enrollment-grant",
    );
    expect(
      store.authenticateInstance(
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
