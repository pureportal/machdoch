import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.ts";
import { parseCliArgs } from "./cli-args.ts";
import { printFleetSummary } from "./cli-fleet-commands.ts";

const mocks = vi.hoisted(() => ({
  path: "",
  enabled: true,
  startupError: false,
  shutdown: vi.fn<() => Promise<void>>(),
  gateway: vi.fn(async () => ({ reason: "disabled" as const })),
}));
vi.mock("../../core/fleet-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/fleet-connection.js")>()),
  getFleetConnectionPath: () => mocks.path,
  loadFleetConnectionConfig: async () => ({ enabled: mocks.enabled }),
}));
vi.mock("./cli-fleet-gateway.js", () => ({
  runFleetGatewayService: mocks.gateway,
}));
vi.mock("./cli-fleet-product.js", () => ({
  FleetCliProductRuntime: {
    create: async () => {
      if (mocks.startupError)
        throw new Error(
          "The workspace root differs from the saved project library.",
        );
      return { shutdown: mocks.shutdown, handleRequest: vi.fn() };
    },
  },
}));

it("keeps the service lock through shutdown and cleans up signal listeners", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-lock-"));
  mocks.path = join(root, "fleet.json");
  mocks.enabled = true;
  const args = parseCliArgs(["fleet", "service", "--cwd", root]);
  const shutdownEntered = Promise.withResolvers<void>();
  const finishShutdown = Promise.withResolvers<void>();
  mocks.shutdown.mockImplementation(async () => {
    shutdownEntered.resolve();
    await finishShutdown.promise;
  });
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeInt = process.listenerCount("SIGINT");
  const service = printFleetSummary(args);
  try {
    await shutdownEntered.promise;
    expect(
      (await inspectCooperativeFileLock(`${mocks.path}.cli-service`)).state,
    ).toBe("active");
    await expect(printFleetSummary(args)).rejects.toThrow(/lock/iu);
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    finishShutdown.resolve();
    await service;
    expect(
      (await inspectCooperativeFileLock(`${mocks.path}.cli-service`)).state,
    ).toBe("unlocked");
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  } finally {
    finishShutdown.resolve();
    await service;
    await rm(root, { recursive: true, force: true });
  }
});

it("uses non-restarting exit status for disabled configuration", async () => {
  mocks.enabled = false;
  await expect(
    printFleetSummary(parseCliArgs(["fleet", "service"])),
  ).rejects.toMatchObject({ exitCode: 78 });
});

it("does not restart-loop on invalid project configuration and releases startup resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-project-startup-"));
  mocks.path = join(root, "fleet.json");
  mocks.enabled = true;
  mocks.startupError = true;
  const beforeTerm = process.listenerCount("SIGTERM");
  try {
    await expect(
      printFleetSummary(parseCliArgs(["fleet", "service", "--cwd", root])),
    ).rejects.toMatchObject({ exitCode: 78 });
    expect(
      (await inspectCooperativeFileLock(`${mocks.path}.cli-service`)).state,
    ).toBe("unlocked");
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  } finally {
    mocks.startupError = false;
    await rm(root, { recursive: true, force: true });
  }
});
