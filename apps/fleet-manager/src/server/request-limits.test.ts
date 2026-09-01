import { describe, expect, it } from "vitest";
import type { FleetManagerConfig } from "./config";
import { maximumRequestBodyBytes } from "./request-limits";

const config = {
  settingsManager: {
    limits: {
      maximumDocumentBytes: 1024 * 1024,
      maximumSecretBytes: 2 * 1024 * 1024,
    },
  },
} as FleetManagerConfig;

describe("Fleet Manager request limits", () => {
  it("keeps authentication payloads small", () => {
    expect(maximumRequestBodyBytes("/api/auth/login", config)).toBe(16 * 1024);
    expect(maximumRequestBodyBytes("/api/auth/account", config)).toBe(
      16 * 1024,
    );
    expect(
      maximumRequestBodyBytes(
        "/api/client/settings/instance_one/sync-status",
        config,
      ),
    ).toBe(16 * 1024);
  });

  it("accounts for the larger configured settings input", () => {
    expect(
      maximumRequestBodyBytes("/api/settings/profiles/profile_one", config),
    ).toBe(2 * 1024 * 1024 + 64 * 1024);
  });
});
