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

import {
  executeLocalCommand,
  normalizeLocalCommandCwd,
} from "./process-execution.ts";

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
  it("normalizes Windows extended-length cwd values before spawning", async () => {
    const commandPromise = executeLocalCommand("pnpm", ["--version"], {
      ...commandOptions,
      cwd: "\\\\?\\C:\\Development\\_others\\machdoch",
    });

    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
      cwd:
        process.platform === "win32"
          ? "C:\\Development\\_others\\machdoch"
          : "\\\\?\\C:\\Development\\_others\\machdoch",
    });

    invokeExecFileCallback(null, "11.6.0\r\n", "");

    await expect(commandPromise).resolves.toEqual({
      stdout: "11.6.0",
      stderr: "",
      exitCode: 0,
    });
  });

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

describe("normalizeLocalCommandCwd", () => {
  it("converts Windows drive extended-length paths for Windows process cwd values", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\?\\C:\\Development\\_others\\machdoch",
        "win32",
      ),
    ).toBe("C:\\Development\\_others\\machdoch");
  });

  it("converts Windows UNC extended-length paths for Windows process cwd values", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\?\\UNC\\server\\share\\machdoch",
        "win32",
      ),
    ).toBe("\\\\server\\share\\machdoch");
  });

  it("converts Windows UNC prefixes case-insensitively", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\?\\unc\\server\\share\\machdoch",
        "win32",
      ),
    ).toBe("\\\\server\\share\\machdoch");
  });

  it("converts Windows DOS device drive paths for process cwd values", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\.\\C:\\Development\\_others\\machdoch",
        "win32",
      ),
    ).toBe("C:\\Development\\_others\\machdoch");
  });

  it("converts Windows DOS device UNC paths for process cwd values", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\.\\UNC\\server\\share\\machdoch",
        "win32",
      ),
    ).toBe("\\\\server\\share\\machdoch");
  });

  it("leaves unsupported namespaced paths unchanged", () => {
    expect(
      normalizeLocalCommandCwd("\\\\?\\Volume{abc}\\machdoch", "win32"),
    ).toBe("\\\\?\\Volume{abc}\\machdoch");
  });

  it("leaves Windows device paths that are not directory cwd values unchanged", () => {
    expect(
      normalizeLocalCommandCwd("\\\\.\\pipe\\machdoch-agent", "win32"),
    ).toBe("\\\\.\\pipe\\machdoch-agent");
  });

  it("leaves paths unchanged outside Windows", () => {
    expect(
      normalizeLocalCommandCwd(
        "\\\\?\\C:\\Development\\_others\\machdoch",
        "linux",
      ),
    ).toBe("\\\\?\\C:\\Development\\_others\\machdoch");
  });
});
