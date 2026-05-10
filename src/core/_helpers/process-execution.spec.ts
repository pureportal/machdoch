/// <reference types="vitest/globals" />

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFile: execFileMock,
  };
});

import { executeLocalCommand } from "./process-execution.ts";

type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

const invokeExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
): void => {
  const callback = execFileMock.mock.calls[0]?.[3];

  if (typeof callback !== "function") {
    throw new Error("Expected execFile callback to be captured.");
  }

  (callback as ExecFileCallback)(error, stdout, stderr);
};

const commandOptions = {
  cwd: "C:\\workspace",
  timeoutMs: 1_000,
  maxBufferBytes: 8_192,
};

beforeEach(() => {
  execFileMock.mockReset();
});

describe("executeLocalCommand", () => {
  it("resolves numeric accepted exit codes", async () => {
    const commandPromise = executeLocalCommand("npm", ["outdated"], {
      ...commandOptions,
      acceptedExitCodes: [0, 1],
    });
    const error = Object.assign(new Error("npm outdated exited with 1"), {
      code: 1,
    });

    invokeExecFileCallback(error, "left-pad@1\r\n", "warning\r\n");

    await expect(commandPromise).resolves.toEqual({
      stdout: "left-pad@1",
      stderr: "warning",
      exitCode: 1,
    });
  });

  it("rejects timeout and spawn failures even when zero is an accepted exit code", async () => {
    const commandPromise = executeLocalCommand("npm", ["audit"], {
      ...commandOptions,
      acceptedExitCodes: [0, 1],
    });
    const error = Object.assign(new Error("Command timed out"), {
      code: "ETIMEDOUT",
    });

    invokeExecFileCallback(error, "partial stdout", "partial stderr");

    await expect(commandPromise).rejects.toMatchObject({
      message: "Command timed out",
      stdout: "partial stdout",
      stderr: "partial stderr",
    });
  });
});
