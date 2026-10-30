/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderProbeResult } from "./types.js";

const { probeProviderCliMock, resolveBinaryMock } = vi.hoisted(() => ({
  probeProviderCliMock: vi.fn(),
  resolveBinaryMock: vi.fn(),
}));

vi.mock("../env.js", () => ({
  loadRuntimeEnvironment: async () => ({}),
}));

vi.mock("../_helpers/agent-cli-providers.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../_helpers/agent-cli-providers.js")
  >()),
  resolveAgentCliProviderBinary: resolveBinaryMock,
}));

vi.mock("./capability-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability-registry.js")>()),
  probeProviderCli: probeProviderCliMock,
}));

import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlanForRuntime } from "./instruction-delivery-preflight.js";

const executable = "C:\\tools\\copilot.exe";
const healthyProbe: ProviderProbeResult = {
  provider: "copilot-cli",
  executable,
  available: true,
  version: "GitHub Copilot CLI 1.0.0",
  features: [
    "--agent",
    "--no-auto-update",
    "--no-custom-instructions",
    "--additional-mcp-config",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
  ],
  warnings: [],
};
const failedProbe: ProviderProbeResult = {
  provider: "copilot-cli",
  executable,
  available: false,
  features: [],
  warnings: [],
  failureReason: `spawn ${executable} EBUSY`,
};
const createPlan = () =>
  createInstructionDeliveryPlanForRuntime(
    createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    }),
    { workspaceRoot: process.cwd() },
  );

describe("createInstructionDeliveryPlanForRuntime CLI recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeProviderCliMock.mockReset();
    resolveBinaryMock.mockReset();
    resolveBinaryMock.mockReturnValue({
      provider: "copilot-cli",
      available: true,
      executable,
      source: "path",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not block a run when the CLI recovers from a brief failure", async () => {
    probeProviderCliMock
      .mockResolvedValueOnce(failedProbe)
      .mockResolvedValueOnce(failedProbe)
      .mockResolvedValueOnce(healthyProbe);

    const plan = createPlan();
    await vi.advanceTimersByTimeAsync(4_000);

    expect((await plan).blockingReasons).toEqual([]);
    expect(probeProviderCliMock).toHaveBeenCalledTimes(3);
    expect(probeProviderCliMock).toHaveBeenNthCalledWith(
      1,
      "copilot-cli",
      executable,
    );
    expect(probeProviderCliMock).toHaveBeenNthCalledWith(
      2,
      "copilot-cli",
      executable,
      { force: true },
    );
  });

  it("re-probes a cached result that lacks required flags", async () => {
    probeProviderCliMock
      .mockResolvedValueOnce({ ...healthyProbe, features: [] })
      .mockResolvedValueOnce(healthyProbe);

    const plan = createPlan();
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await plan).blockingReasons).toEqual([]);
    expect(probeProviderCliMock).toHaveBeenCalledTimes(2);
  });

  it("reports the failure once the CLI stays unavailable", async () => {
    probeProviderCliMock.mockResolvedValue(failedProbe);

    const plan = createPlan();
    await vi.advanceTimersByTimeAsync(12_000);

    expect((await plan).blockingReasons.join(" ")).toContain(
      `The selected CLI did not respond to --version or --help: spawn ${executable} EBUSY`,
    );
    expect(probeProviderCliMock).toHaveBeenCalledTimes(4);
  });

  it("reports a missing binary without waiting", async () => {
    resolveBinaryMock.mockReturnValue({
      provider: "copilot-cli",
      available: false,
      reason: "Copilot CLI was not found on PATH.",
    });

    const plan = await createPlan();

    expect(plan.blockingReasons.join(" ")).toContain(
      "Copilot CLI was not found on PATH.",
    );
    expect(probeProviderCliMock).not.toHaveBeenCalled();
  });
});
