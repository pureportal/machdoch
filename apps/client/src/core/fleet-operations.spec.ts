import { describe, expect, it, vi } from "vitest";
import { FleetOperationStore } from "./fleet-operations.js";

describe("Fleet operation store", () => {
  it("replays an invocation once, preserves pending work, and rejects changed arguments", async () => {
    const store = new FleetOperationStore();
    let resolveResult!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveResult = resolve;
        }),
    );
    const request = { kind: "invoke", id: "operation-1", command: "save" };
    expect(await store.handle(request, invoke)).toEqual({ state: "pending" });
    expect(await store.handle(request, invoke)).toEqual({ state: "pending" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(
      (await store.handle({ ...request, command: "run" }, invoke)).state,
    ).toBe("failed");
    expect(
      (await store.handle({ kind: "release", id: request.id }, invoke)).state,
    ).toBe("failed");
    resolveResult({ name: "Saved flow", revision: 2 });
    await expect
      .poll(
        async () =>
          (
            await store.handle(
              { kind: "read", id: request.id, offset: 0 },
              invoke,
            )
          ).state,
      )
      .toBe("complete");
    const response = await store.handle(
      { kind: "read", id: request.id, offset: 0 },
      invoke,
    );
    if (response.state !== "complete")
      throw new Error("Expected saved response.");
    expect(
      JSON.parse(Buffer.from(response.chunk, "base64").toString()),
    ).toEqual({ name: "Saved flow", revision: 2 });
    expect(
      (
        await store.handle(
          { kind: "read", id: request.id, offset: response.total + 1 },
          invoke,
        )
      ).state,
    ).toBe("failed");
    await store.handle({ kind: "release", id: request.id }, invoke);
    expect(
      (await store.handle({ kind: "read", id: request.id, offset: 0 }, invoke))
        .state,
    ).toBe("failed");
  });

  it("bounds unfinished operations and progress without losing their cursor", async () => {
    const store = new FleetOperationStore();
    const invoke = () => new Promise<unknown>(() => {});
    for (let index = 0; index < 16; index += 1)
      expect(
        (
          await store.handle(
            { kind: "invoke", id: `operation-${index}` },
            invoke,
          )
        ).state,
      ).toBe("pending");
    expect(
      (await store.handle({ kind: "invoke", id: "overflow" }, invoke)).state,
    ).toBe("failed");
    expect(
      (
        await store.handle(
          { kind: "invoke", id: "cancel", command: "cancel_desktop_task" },
          async () => null,
        )
      ).state,
    ).toBe("pending");
    for (let index = 0; index < 80; index += 1)
      store.recordProgress({ taskId: "task-1", index });
    store.recordProgress({ oversized: "x".repeat(16_385) });
    const events = await store.handle({ kind: "events", after: 0 }, invoke);
    expect(events.state).toBe("events");
    if (events.state !== "events") return;
    expect(events.cursor).toBe(80);
    expect(events.events).toHaveLength(64);
    expect(events.events[0]!.payload).toEqual({ taskId: "task-1", index: 16 });
  });
});
