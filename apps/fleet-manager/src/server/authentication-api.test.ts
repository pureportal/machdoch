import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "./auth-store";
import { AuthenticationRateLimiter } from "./authentication-rate-limiter";
import { handleApiRequest } from "./api";
import type { FleetManagerConfig } from "./config";
import { createSecret } from "./crypto";
import { FleetDatabase, nowSeconds } from "./database";
import { FleetStore } from "./fleet-store";
import { GatewayHub } from "./gateway";
import { setRuntimeForTests, type FleetRuntime } from "./runtime";
import { SettingsStore } from "./settings-store";

const ownerPassword = "a secure test password";
let runtime: FleetRuntime;

beforeEach(() => {
  runtime = testRuntime();
  runtime.authStore.seedOwner("owner", ownerPassword, nowSeconds());
  setRuntimeForTests(runtime);
});

afterEach(() => {
  setRuntimeForTests(undefined);
  runtime.gateways.close();
  runtime.database.close();
});

describe("Fleet Manager authentication API", () => {
  it("limits one client without locking out a different client", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login("198.51.100.10", "incorrect password")).status).toBe(
        401,
      );
    }

    const limited = await login("198.51.100.10", ownerPassword);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await login("198.51.100.11", ownerPassword)).status).toBe(200);
  });

  it("counts malformed login submissions toward the client limit", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await rawLogin("198.51.100.10", "{");
      expect(response.status).toBe(401);
    }

    expect((await login("198.51.100.10", ownerPassword)).status).toBe(429);
  });

  it("rejects excess concurrent password work with a short retry delay", async () => {
    const operations = Array.from({ length: 4 }, () =>
      runtime.authenticationRateLimiter.beginPasswordOperation(),
    );

    const response = await login("198.51.100.10", ownerPassword);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    operations.forEach((operation) => operation?.release());
    expect((await login("198.51.100.10", ownerPassword)).status).toBe(200);
  });

  it("requires the configured external origin even with spoofed proxy headers", async () => {
    const response = await handleApiRequest(
      new Request("http://127.0.0.1/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "X-Forwarded-Host": "attacker.example",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ username: "owner", password: ownerPassword }),
      }),
      { clientAddress: "198.51.100.10" },
    );

    expect(response.status).toBe(403);
  });

  it("accepts owner usernames up to 64 Unicode characters", async () => {
    const username = "😀".repeat(64);
    runtime.authStore.seedOwner(username, ownerPassword, nowSeconds());

    const response = await rawLogin(
      "198.51.100.10",
      JSON.stringify({ username, password: ownerPassword }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects directional controls in stored owner names", () => {
    expect(() =>
      runtime.authStore.seedOwner(
        "owner\u202espoofed",
        ownerPassword,
        nowSeconds(),
      ),
    ).toThrow("unsupported characters");
  });

  it("rejects unsupported and oversized authentication bodies", async () => {
    const unsupported = await handleApiRequest(
      new Request("https://fleet.example.test/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "text/plain", Origin: origin },
        body: JSON.stringify({ username: "owner", password: ownerPassword }),
      }),
      { clientAddress: "198.51.100.10" },
    );
    expect(unsupported.status).toBe(415);

    const oversized = await rawLogin(
      "198.51.100.11",
      JSON.stringify({
        username: "owner",
        password: ownerPassword,
        padding: "x".repeat(17 * 1024),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  it("maps malformed encoded API paths to a client error", async () => {
    const response = await handleApiRequest(
      new Request(`${origin}/api/auth/%`),
      { clientAddress: "198.51.100.10" },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rate limits current-password confirmation by session", async () => {
    const authenticated = await login("198.51.100.10", ownerPassword);
    const cookies = authenticated.headers.getSetCookie();
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrf = /^__Host-machdoch_fleet_csrf=([^;]+)/mu.exec(
      cookies.join("\n"),
    )?.[1];
    expect(csrf).toBeTruthy();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await updateAccount(cookie, csrf ?? "", "wrong");
      expect(response.status).toBe(403);
    }

    const limited = await updateAccount(cookie, csrf ?? "", ownerPassword);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("clears stale browser credentials after an account update conflict", async () => {
    const authenticated = await login("198.51.100.10", ownerPassword);
    const cookies = authenticated.headers.getSetCookie();
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const csrf = /^__Host-machdoch_fleet_csrf=([^;]+)/mu.exec(
      cookies.join("\n"),
    )?.[1];
    vi.spyOn(
      runtime.authStore,
      "changeOwnerAccountForSession",
    ).mockResolvedValue("stale");

    const response = await updateAccount(cookie, csrf ?? "", ownerPassword);

    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__Host-machdoch_fleet_session=;.*Max-Age=0/iu),
        expect.stringMatching(/^__Host-machdoch_fleet_csrf=;.*Max-Age=0/iu),
      ]),
    );
  });

  it("does not disguise enrollment storage failures as invalid credentials", async () => {
    vi.spyOn(runtime.fleetStore, "enrollInstance").mockImplementation(() => {
      throw new Error("database storage failed");
    });

    const response = await handleApiRequest(
      new Request(`${origin}/api/enroll`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${createSecret("mch_enroll")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Workstation",
          instanceSecret: createSecret("mch_instance"),
          productVersion: "7.0.6",
          protocolVersion: gatewayProtocolVersion,
        }),
      }),
      { clientAddress: "198.51.100.10" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Fleet Manager is unavailable.",
    });
  });
});

const origin = "https://fleet.example.test";

async function login(
  clientAddress: string,
  password: string,
): Promise<Response> {
  return rawLogin(
    clientAddress,
    JSON.stringify({ username: "owner", password }),
  );
}

async function rawLogin(
  clientAddress: string,
  body: string,
): Promise<Response> {
  return handleApiRequest(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body,
    }),
    { clientAddress },
  );
}

async function updateAccount(
  cookie: string,
  csrf: string,
  currentPassword: string,
): Promise<Response> {
  return handleApiRequest(
    new Request(`${origin}/api/auth/account`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
        "X-Machdoch-Fleet-CSRF": csrf,
      },
      body: JSON.stringify({
        username: "owner",
        currentPassword,
        newPassword: "a different secure password",
      }),
    }),
    { clientAddress: "198.51.100.10" },
  );
}

function testRuntime(): FleetRuntime {
  const config: FleetManagerConfig = {
    schemaVersion: 1,
    externalBaseUrl: origin,
    listen: { address: "127.0.0.1", port: 43188 },
    database: { path: ":memory:" },
    sessionPolicy: {
      idleSeconds: 1800,
      absoluteSeconds: 43_200,
      maximumConcurrentSessions: 8,
    },
    enrollmentPolicy: { keyLifetimeSeconds: 900, maximumOutstandingKeys: 8 },
    connectionPolicy: { requestTimeoutSeconds: 1, heartbeatTimeoutSeconds: 45 },
    settingsManager: {
      enabled: false,
      limits: {
        maximumProfiles: 64,
        maximumInstructionsPerProfile: 128,
        maximumPacksPerProfile: 128,
        maximumPromptsPerProfile: 128,
        maximumRevisionsPerProfile: 100,
        maximumDocumentBytes: 1024 * 1024,
        maximumSecretBytes: 8192,
      },
    },
  };
  const database = new FleetDatabase(":memory:");
  const authStore = new AuthStore(database);
  const fleetStore = new FleetStore(database);
  return {
    config,
    database,
    authStore,
    fleetStore,
    settingsStore: new SettingsStore(database),
    settingsCipher: null,
    gateways: new GatewayHub(config, fleetStore),
    authenticationRateLimiter: new AuthenticationRateLimiter(),
  };
}
