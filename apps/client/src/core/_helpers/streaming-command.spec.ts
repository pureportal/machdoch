/// <reference types="vitest/globals" />
/// <reference lib="es2024.promise" />
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runStreamingCommand } from "./streaming-command.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
const options = { cwd: process.cwd(), timeoutMs: 100, maxBufferBytes: 16 };

beforeEach(() => {
  vi.useFakeTimers();
  spawnMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const childProcess = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });

it("settles when neither the child nor its cleanup helper emits close", async () => {
  const child = childProcess();
  const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
  vi.spyOn(process, "kill").mockImplementation(() => true);
  spawnMock.mockImplementation((program: string) =>
    program === "taskkill" ? killer : child,
  );
  const result = runStreamingCommand("test", [], options);
  const assertion = expect(result).rejects.toMatchObject({ timedOut: true });
  await vi.advanceTimersByTimeAsync(4_000);
  await assertion;
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  if (process.platform === "win32") {
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(killer.kill).toHaveBeenCalledTimes(1);
  } else {
    expect(process.kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves UTF-8 characters split across output chunks", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const result = runStreamingCommand("test", [], options);
  const bytes = Buffer.from("A€😀Z");
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.emit("close", 0, null);
  await expect(result).resolves.toMatchObject({ stdout: "A€😀Z" });
});

it("streams binary stdout without retaining or decoding it and closes stdin even for empty input", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const onStdoutBytes = vi.fn();
  const result = runStreamingCommand("test", [], {
    ...options,
    input: Buffer.alloc(0),
    onStdoutBytes,
  });
  const bytes = Buffer.from([0, 255, 128, ...Array<number>(32).fill(1)]);
  child.stdout.write(bytes);
  expect(child.stdin.writableEnded).toBe(true);
  child.emit("close", 0, null);
  await expect(result).resolves.toMatchObject({ stdout: "" });
  expect(onStdoutBytes).toHaveBeenCalledWith(bytes);
  expect(child.stdin.destroyed).toBe(true);
});

it("preserves exact output when normalization is disabled", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const result = runStreamingCommand("test", [], {
    ...options,
    normalizeOutput: false,
  });
  child.stdout.write("  path\r\n");
  child.emit("close", 0, null);
  await expect(result).resolves.toMatchObject({ stdout: "  path\r\n" });
});

it("does not spawn a process for an already cancelled request", async () => {
  const signal = AbortSignal.abort("cancelled before start");
  await expect(
    runStreamingCommand("test", [], { ...options, signal }),
  ).rejects.toMatchObject({ code: "ABORT_ERR" });
  expect(spawnMock).not.toHaveBeenCalled();
});

it("stops after an asynchronous output handler fails", async () => {
  const child = childProcess();
  // Without a pid this also exercises the direct-child fallback.
  Object.assign(child, { pid: undefined });
  spawnMock.mockReturnValue(child);
  const result = runStreamingCommand("test", [], {
    ...options,
    timeoutMs: 5_000,
    onOutput: async () => {
      throw new Error("sink unavailable");
    },
  });
  const assertion = expect(result).rejects.toThrow("sink unavailable");
  child.stdout.write("data");
  await vi.advanceTimersByTimeAsync(2_000);
  await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("applies backpressure to slow output handlers and waits for the last handler", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const onOutput = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  let settled = false;
  const result = runStreamingCommand("test", [], {
    ...options,
    timeoutMs: 5000,
    onOutput,
  }).then((value) => {
    settled = true;
    return value;
  });
  child.stdout.write("first");
  child.stdout.write("second");
  expect(onOutput).toHaveBeenCalledTimes(1);
  first.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(onOutput).toHaveBeenCalledTimes(2);
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  second.resolve();
  await expect(result).resolves.toMatchObject({ stdout: "firstsecond" });
});

it("reports a late handler rejection even after the process has closed", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const handler = Promise.withResolvers<void>();
  const result = runStreamingCommand("test", [], {
    ...options,
    onOutput: () => handler.promise,
  });
  const assertion = expect(result).rejects.toThrow("late sink failure");
  child.stdout.write("data");
  child.emit("close", 0, null);
  handler.reject(new Error("late sink failure"));
  await assertion;
  expect(spawnMock).toHaveBeenCalledTimes(1);
});

it("still times out if the final output handler never resolves", async () => {
  const child = childProcess();
  spawnMock.mockReturnValue(child);
  const result = runStreamingCommand("test", [], {
    ...options,
    onOutput: () => new Promise<void>(() => {}),
  });
  const assertion = expect(result).rejects.toMatchObject({ timedOut: true });
  child.stdout.write("data");
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  expect(spawnMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up the process when an output pipe fails", async () => {
  const child = childProcess();
  const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
  vi.spyOn(process, "kill").mockImplementation(() => true);
  spawnMock.mockImplementation((program: string) =>
    program === "taskkill" ? killer : child,
  );
  const result = runStreamingCommand("test", [], {
    ...options,
    timeoutMs: 5_000,
  });
  const assertion = expect(result).rejects.toThrow("pipe failed");
  child.stdout.emit("error", new Error("pipe failed"));
  await vi.advanceTimersByTimeAsync(4_000);
  await assertion;
  expect(child.stdout.destroyed).toBe(true);
});

it.skipIf(process.platform !== "win32")(
  "does not launch a cleanup process for normal Windows command exits",
  async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const result = runStreamingCommand("test", [], options);
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);
