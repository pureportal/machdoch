import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@machdoch/product-ui/fleet-api";
import { createInstanceRuntime } from "./instance-runtime";
import { productFixture as snapshot } from "../test/product-fixture";

vi.mock("@machdoch/product-ui/fleet-api", () => ({
  api: vi.fn(),
  jsonBody: JSON.stringify,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("fleet session navigation", () => {
  it("opens a valid historical session outside the bounded live session window", async () => {
    const initial = snapshot();
    const historical = { ...initial.shell!.sessions[0]!, id: "historical" };
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("commands")) {
        initial.shell!.activeSessionId = historical.id;
        initial.shell!.sessions.push(historical);
        return {
          commandId: JSON.parse(init!.body as string).commandId,
          duplicate: false,
        };
      }
      return structuredClone(initial);
    });
    expect(
      (await createInstanceRuntime("device", historical.id).getSnapshot()).shell
        ?.activeSessionId,
    ).toBe(historical.id);
  });

  it("waits for a matching full native draft without exposing the truncated snapshot", async () => {
    const initial = snapshot();
    initial.shell!.composer!.textTruncated = true;
    initial.shell!.composer!.draft = "Short projection";
    initial.shell!.composer!.draftRevision = 1;
    const full = {
      sessionId: initial.shell!.composer!.sessionId,
      draft: "🌿".repeat(9_000),
      draftRevision: 2,
      history: [],
      queuedMessages: [],
    };
    const read = vi.fn().mockResolvedValue(full);
    vi.mocked(api)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({
        ...initial,
        shell: {
          ...initial.shell,
          composer: { ...initial.shell!.composer, draftRevision: 2 },
        },
      });
    const loaded = await createInstanceRuntime(
      "device",
      undefined,
      read,
    ).getSnapshot();
    expect(loaded.shell!.composer!.draft).toBe(full.draft);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("selects the requested session once through the normal command endpoint", async () => {
    const initial = snapshot();
    const sessionId = initial.shell!.sessions[0]!.id;
    initial.shell!.activeSessionId = "other";
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("commands")) {
        initial.shell!.activeSessionId = sessionId;
        return {
          commandId: JSON.parse(init!.body as string).commandId,
          duplicate: false,
        };
      }
      return initial;
    });
    const runtime = createInstanceRuntime("device", sessionId);
    expect((await runtime.getSnapshot()).shell?.activeSessionId).toBe(
      sessionId,
    );
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

  it("waits for queued desktop activation before exposing the composer", async () => {
    const initial = snapshot();
    const sessionId = initial.shell!.sessions[0]!.id;
    initial.shell!.activeSessionId = "other";
    let queued = false;
    let pendingReads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("commands")) {
        queued = true;
        return {
          commandId: JSON.parse(init!.body as string).commandId,
          duplicate: false,
        };
      }
      if (queued && ++pendingReads === 3)
        initial.shell!.activeSessionId = sessionId;
      return structuredClone(initial);
    });
    const runtime = createInstanceRuntime("device", sessionId);
    const selected = await runtime.getSnapshot();
    expect(selected.shell?.activeSessionId).toBe(sessionId);
    expect(pendingReads).toBe(3);
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("commands")),
    ).toHaveLength(1);
  });

  it("retries confirmation with the same command identity when activation is unconfirmed", async () => {
    const initial = snapshot();
    const sessionId = initial.shell!.sessions[0]!.id;
    initial.shell!.activeSessionId = "other";
    let queued = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("commands")) {
        queued = true;
        return {
          commandId: JSON.parse(init!.body as string).commandId,
          duplicate: false,
        };
      }
      if (queued) vi.setSystemTime(Date.now() + 9_000);
      return initial;
    });
    const runtime = createInstanceRuntime("device", sessionId);
    await expect(runtime.getSnapshot()).rejects.toThrow(
      "could not be selected",
    );
    initial.shell!.activeSessionId = sessionId;
    expect((await runtime.getSnapshot()).shell?.activeSessionId).toBe(
      sessionId,
    );
    expect(
      vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("commands")),
    ).toHaveLength(1);
  });

  it("does not select missing sessions or issue commands after cancellation", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.endsWith("commands"))
        throw new Error("This session is no longer on the device.");
      return snapshot();
    });
    await expect(
      createInstanceRuntime("device", "missing").getSnapshot(),
    ).rejects.toThrow("no longer");
    vi.mocked(api).mockClear();
    const controller = new AbortController();
    controller.abort();
    const initial = snapshot();
    initial.shell!.activeSessionId = "other";
    vi.mocked(api).mockResolvedValue(initial);
    await expect(
      createInstanceRuntime(
        "device",
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
      createInstanceRuntime("device").execute({
        kind: "cancel",
        taskId: "task",
        commandId: "command",
      }),
    ).rejects.toThrow("invalid command receipt");
  });
});
