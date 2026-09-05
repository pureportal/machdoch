/// <reference lib="es2024.promise" />
import { expect, it, vi } from "vitest";
import { runTaskGitCommand } from "./task-git-command.js";

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("./streaming-command.js", () => ({ runStreamingCommand: runCommand }));

it("shares a process limit across callers and releases a slot after failures", async () => {
  const gates = Array.from({ length: 6 }, () =>
    Promise.withResolvers<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>(),
  );
  runCommand.mockImplementation(
    (_program: string, args: string[]) => gates[Number(args.at(-1))]?.promise,
  );
  const requests = gates.map((_, index) =>
    runTaskGitCommand([String(index)], {
      cwd: process.cwd(),
      timeoutMs: 100,
      maxBufferBytes: 100,
    }),
  );
  const results = Promise.allSettled(requests);
  await Promise.resolve();
  expect(runCommand).toHaveBeenCalledTimes(4);
  gates[0]?.reject(new Error("failed"));
  await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(5));
  gates[1]?.resolve({ stdout: "", stderr: "", exitCode: 0 });
  await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(6));
  for (const gate of gates.slice(2))
    gate.resolve({ stdout: "", stderr: "", exitCode: 0 });
  expect((await results).map((result) => result.status)).toEqual([
    "rejected",
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
    "fulfilled",
  ]);
});
