import { afterEach, expect, it, vi } from "vitest";
import { createFleetOperationTransport } from "./fleet-operation-transport";

afterEach(() => vi.restoreAllMocks());

it("delivers a complete result while remote cleanup is still pending", async () => {
  const chunk = btoa(JSON.stringify({ sessions: [{ id: "chat" }] }));
  let finishRelease!: (response: unknown) => void;
  const send = vi.fn<Parameters<typeof createFleetOperationTransport>[0]>(
    async (request) => {
      if (request.kind === "invoke") return { state: "pending" };
      if (request.kind === "release")
        return new Promise((resolve) => {
          finishRelease = resolve;
        });
      return { state: "complete", chunk, offset: 0, total: chunk.length };
    },
  );
  const transport = createFleetOperationTransport(send);
  await expect(transport.invoke("get_session_index")).resolves.toEqual({
    sessions: [{ id: "chat" }],
  });
  expect(send.mock.calls.map(([request]) => request.kind)).toEqual([
    "invoke",
    "read",
    "release",
  ]);
  finishRelease({ state: "complete", chunk: "", offset: 0, total: 0 });
});

it("reports cleanup failures without replacing the operation error", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const cleanupError = new Error("Disconnected during cleanup");
  const transport = createFleetOperationTransport(async (request) => {
    if (request.kind === "invoke") return { state: "pending" };
    if (request.kind === "release") throw cleanupError;
    return { state: "failed", error: "Session was removed" };
  });
  await expect(transport.invoke("get_session_index")).rejects.toThrow(
    "Session was removed",
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      "Could not release remote operation",
      cleanupError,
    ),
  );
});
