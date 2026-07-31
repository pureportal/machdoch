import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import { getUserConfigPath } from "../env.js";
import {
  normalizeProviderEnrollmentConfig,
  setPersistentProviderSyncEnabled,
} from "./config.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider enrollment configuration", () => {
  it("reads provider state inside the shared lock before updating sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-provider-config-"));
    roots.push(root);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
    const path = getUserConfigPath();
    await writeFile(
      path,
      `${JSON.stringify({
        marker: "preserve",
        providerEnrollment: {
          schemaVersion: 1,
          enabled: true,
          persistentSync: { enabled: false },
          providers: {
            "codex-cli": { enabled: true },
            "claude-cli": { enabled: true },
            "copilot-cli": { enabled: true },
          },
        },
      })}\n`,
      "utf8",
    );

    let pendingUpdate:
      | ReturnType<typeof setPersistentProviderSyncEnabled>
      | undefined;
    await withCooperativeFileLock(path, async () => {
      pendingUpdate = setPersistentProviderSyncEnabled(true);
      // Let the competing update reach the lock. Before the regression fix it
      // had already read stale provider state by this point.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = JSON.parse(await readFile(path, "utf8")) as {
        providerEnrollment: {
          providers: Record<string, { enabled: boolean }>;
        };
      };
      current.providerEnrollment.providers["claude-cli"] = { enabled: false };
      await writeFile(path, `${JSON.stringify(current)}\n`, "utf8");
    });

    const updated = await pendingUpdate;
    expect(updated).toBeDefined();
    expect(updated?.persistentSync.enabled).toBe(true);
    expect(updated?.providers["claude-cli"].enabled).toBe(false);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      marker: string;
      providerEnrollment: {
        persistentSync: { enabled: boolean };
        providers: Record<string, { enabled: boolean }>;
      };
    };
    expect(stored.marker).toBe("preserve");
    expect(stored.providerEnrollment.persistentSync.enabled).toBe(true);
    expect(
      stored.providerEnrollment.providers["claude-cli"]?.enabled,
    ).toBe(false);
  });

  it("rejects provider enrollment state without the current schema version", () => {
    expect(() =>
      normalizeProviderEnrollmentConfig({
        enabled: true,
      } as never),
    ).toThrow("schemaVersion must be 1");
  });
});
