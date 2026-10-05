import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@machdoch/product-ui/fleet-api";
import { createInstanceRuntime } from "./instance-runtime";
import { productFixture as snapshot } from "../test/product-fixture";

vi.mock("@machdoch/product-ui/fleet-api", () => ({
  api: vi.fn(),
  jsonBody: JSON.stringify,
}));
afterEach(() => vi.resetAllMocks());

describe("fleet session navigation", () => {
  it("selects the requested session once through the normal command endpoint", async () => {
    const initial = snapshot();
    const sessionId = initial.shell!.sessions[0]!.id;
    initial.shell!.activeSessionId = "other";
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("commands"))
        return {
          commandId: JSON.parse(init!.body as string).commandId,
          duplicate: false,
        };
      return initial;
    });
    const runtime = createInstanceRuntime("device", false, sessionId);
    await runtime.getSnapshot();
    await runtime.getSnapshot();
    const commands = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path.endsWith("commands"));
    expect(commands).toHaveLength(1);
    expect(JSON.parse(commands[0]![1]!.body as string)).toMatchObject({
      kind: "activate-session",
      sessionId,
    });
  });

  it("does not select missing sessions or issue commands after cancellation", async () => {
    vi.mocked(api).mockResolvedValue(snapshot());
    await expect(
      createInstanceRuntime("device", false, "missing").getSnapshot(),
    ).rejects.toThrow("no longer");
    const controller = new AbortController();
    controller.abort();
    const initial = snapshot();
    initial.shell!.activeSessionId = "other";
    vi.mocked(api).mockResolvedValue(initial);
    await expect(
      createInstanceRuntime(
        "device",
        false,
        initial.shell!.sessions[0]!.id,
      ).getSnapshot(controller.signal),
    ).rejects.toThrow();
    expect(
      vi.mocked(api).mock.calls.every(([path]) => path.endsWith("snapshot")),
    ).toBe(true);
  });

  it("rejects a receipt for a different command", async () => {
    vi.mocked(api).mockResolvedValue({
      commandId: "another-command",
      duplicate: false,
    });
    await expect(
      createInstanceRuntime("device", false).execute({
        kind: "cancel",
        taskId: "task",
        commandId: "command",
      }),
    ).rejects.toThrow("invalid command receipt");
  });
});
