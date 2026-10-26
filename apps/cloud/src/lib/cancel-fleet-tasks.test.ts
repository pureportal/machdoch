import { afterEach, expect, it, vi } from "vitest";
import { api } from "@machdoch/product-ui/fleet-api";
import { productCommandSchema } from "@machdoch/fleet-protocol";
import { cancelFleetTasks } from "./cancel-fleet-tasks";

vi.mock("@machdoch/product-ui/fleet-api", () => ({
  api: vi.fn(),
  jsonBody: JSON.stringify,
}));
afterEach(() => vi.resetAllMocks());

it("bounds concurrent cancellations and preserves per-device failures", async () => {
  let active = 0;
  let maximum = 0;
  const commandIds = new Set<string>();
  vi.mocked(api).mockImplementation(async (_path, init) => {
    const command = productCommandSchema.parse(
      JSON.parse(init!.body as string),
    );
    expect(command.kind).toBe("cancel");
    commandIds.add(command.commandId!);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (command.kind === "cancel" && command.taskId === "failed")
      throw new Error("Device disconnected.");
    return { commandId: command.commandId, duplicate: false };
  });
  const targets = Array.from({ length: 12 }, (_, index) => ({
    instanceId: `device-${index}`,
    displayName: `Device ${index}`,
    taskId: index === 3 ? "failed" : `task-${index}`,
  }));
  const results = await cancelFleetTasks(targets);
  expect(maximum).toBe(4);
  expect(commandIds.size).toBe(12);
  expect(results.filter((result) => result.error === null)).toHaveLength(11);
  expect(results[3]).toEqual({
    key: "device-3/failed",
    error: "Device 3: Device disconnected.",
  });
});
