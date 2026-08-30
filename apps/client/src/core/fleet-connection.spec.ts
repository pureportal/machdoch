import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrollFleetConnection,
  getFleetConnectionPath,
  loadFleetConnectionConfig,
  loadFleetConnectionStatus,
  resetFleetConnection,
  setFleetConnectionEnabled,
  validateFleetManagerUrl,
  writeFleetConnectionConfig,
} from "./fleet-connection.ts";

const roots: string[] = [];

const createConfigDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-connection-"));
  roots.push(root);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
  return root;
};

const encoded = (length: number, fill: number): string =>
  Buffer.alloc(length, fill).toString("base64url");

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("Fleet connection configuration", () => {
  it("shares one strict connection document across status and enablement", async () => {
    const root = await createConfigDirectory();
    const config = {
      schemaVersion: 1 as const,
      enabled: true,
      managerUrl: "https://fleet.example.test",
      managerId: `manager_${encoded(18, 1)}`,
      instanceId: `instance_${encoded(18, 2)}`,
      displayName: "Build host",
      instanceSecret: `mch_instance_${encoded(32, 3)}`,
    };

    await writeFleetConnectionConfig(config);
    await setFleetConnectionEnabled(false);

    expect(await loadFleetConnectionConfig()).toEqual({
      ...config,
      enabled: false,
    });
    expect(await loadFleetConnectionStatus()).toEqual({
      configured: true,
      enabled: false,
      configPath: join(root, "fleet-connection.json"),
      managerUrl: config.managerUrl,
      managerId: config.managerId,
      instanceId: config.instanceId,
      displayName: config.displayName,
    });
    expect(JSON.stringify(await loadFleetConnectionStatus())).not.toContain(
      config.instanceSecret,
    );

    await resetFleetConnection();
    await expect(loadFleetConnectionConfig()).resolves.toBeNull();
    await expect(setFleetConnectionEnabled(false)).resolves.toBe(
      getFleetConnectionPath(),
    );
  });

  it("enrolls without retaining the one-time enrollment key", async () => {
    const root = await createConfigDirectory();
    const enrollmentKey = `mch_enroll_${encoded(32, 4)}`;
    const managerId = `manager_${encoded(18, 5)}`;
    const instanceId = `instance_${encoded(18, 6)}`;
    const requestBodies: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(
        JSON.stringify({
          managerId,
          managerUrl: "https://fleet.example.test",
          instanceId,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const config = await enrollFleetConnection({
      managerUrl: "https://fleet.example.test",
      enrollmentKey,
      displayName: "Headless host",
      productVersion: "6.3.0",
      protocolVersion: 4,
      fetch,
    });

    expect(config).toMatchObject({
      enabled: true,
      managerId,
      instanceId,
      displayName: "Headless host",
    });
    expect(requestBodies[0]).toMatchObject({
      displayName: "Headless host",
      productVersion: "6.3.0",
      protocolVersion: 4,
    });
    const persisted = await readFile(
      join(root, "fleet-connection.json"),
      "utf8",
    );
    expect(persisted).not.toContain(enrollmentKey);
    expect(persisted).toContain(config.instanceSecret);
  });

  it("accepts HTTPS origins and rejects insecure or path-bearing manager URLs", () => {
    expect(validateFleetManagerUrl("https://fleet.example.test").origin).toBe(
      "https://fleet.example.test",
    );
    expect(() => validateFleetManagerUrl("http://fleet.example.test")).toThrow(
      "must use HTTPS",
    );
    expect(() =>
      validateFleetManagerUrl("https://fleet.example.test/path"),
    ).toThrow("must be an origin");
  });
});
