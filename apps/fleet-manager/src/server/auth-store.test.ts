import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";

const sessionPolicy = {
  idleSeconds: 1800,
  absoluteSeconds: 43_200,
  maximumConcurrentSessions: 8,
};

let database: FleetDatabase | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

describe("owner authentication state", () => {
  it("does not create a session after the verified password was replaced", async () => {
    const store = createStore();
    const now = nowSeconds();
    store.seedOwner("owner", "the original secure password", now);

    const login = store.createOwnerSessionForCredentials(
      "owner",
      "the original secure password",
      createSecret("mch_session"),
      createSecret("mch_csrf"),
      "Browser",
      now,
      sessionPolicy,
    );
    store.changeOwnerPassword("owner", "the replacement password", now + 1);

    await expect(login).resolves.toBe(false);
    expect(store.listOwnerSessions(now + 1)).toEqual([]);
  });

  it("does not change credentials after the authorizing session was revoked", async () => {
    const store = createStore();
    const now = nowSeconds();
    store.seedOwner("owner", "the original secure password", now);
    const sessionToken = createSecret("mch_session");
    await expect(
      store.createOwnerSessionForCredentials(
        "owner",
        "the original secure password",
        sessionToken,
        createSecret("mch_csrf"),
        "Browser",
        now,
        sessionPolicy,
      ),
    ).resolves.toBe(true);
    const session = store.authenticateSession(sessionToken, now, 1800);
    if (!session) throw new Error("Test session was not created.");

    const change = store.changeOwnerAccountForSession(
      session,
      "the original secure password",
      "owner",
      "another replacement password",
      now + 1,
    );
    store.revokeSessionByHash(session.sessionHash, now + 1);

    await expect(change).resolves.toBe("stale");
    await expect(
      store.createOwnerSessionForCredentials(
        "owner",
        "the original secure password",
        createSecret("mch_session"),
        createSecret("mch_csrf"),
        "Browser",
        now + 2,
        sessionPolicy,
      ),
    ).resolves.toBe(true);
  });
});

function createStore(): AuthStore {
  database = new FleetDatabase(":memory:");
  return new AuthStore(database);
}
