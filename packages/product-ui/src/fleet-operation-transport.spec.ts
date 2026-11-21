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

it("retries transient network failures without restarting the operation", async () => {
  vi.useFakeTimers();
  const chunk = btoa(JSON.stringify({ ok: true }));
  let reads = 0;
  const send = vi.fn<Parameters<typeof createFleetOperationTransport>[0]>(
    async (request) => {
      if (request.kind === "invoke") return { state: "pending" };
      if (request.kind === "release")
        return { state: "complete", chunk: "", offset: 0, total: 0 };
      reads += 1;
      if (reads === 1) throw new TypeError("Failed to fetch");
      if (reads === 2) throw Object.assign(new Error("Bad gateway"), { status: 502 });
      return { state: "complete", chunk, offset: 0, total: chunk.length };
    },
  );
  const result = createFleetOperationTransport(send).invoke("get_status");
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual({ ok: true });
  const invokes = send.mock.calls.filter(([request]) => request.kind === "invoke");
  expect(invokes).toHaveLength(1);
  expect(reads).toBe(3);
  vi.useRealTimers();
});

it("releases the remote result when a download is interrupted", async () => {
  vi.useFakeTimers();
  const send = vi.fn<Parameters<typeof createFleetOperationTransport>[0]>(
    async (request) => {
      if (request.kind === "invoke") return { state: "pending" };
      if (request.kind === "release")
        return { state: "complete", chunk: "", offset: 0, total: 0 };
      if (request.offset === 0)
        return { state: "complete", chunk: "AAAA", offset: 0, total: 8 };
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    },
  );
  const result = createFleetOperationTransport(send).invoke("read_file");
  const settled = expect(result).rejects.toThrow("Forbidden");
  await vi.runAllTimersAsync();
  await settled;
  expect(send.mock.calls.at(-1)?.[0].kind).toBe("release");
  vi.useRealTimers();
});
