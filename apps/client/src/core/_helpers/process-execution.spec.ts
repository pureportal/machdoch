/// <reference types="vitest/globals" />
import {
  executeLocalCommand,
  formatLocalCommandError,
  getLocalCommandErrorDetails,
  normalizeLocalCommandCwd,
} from "./process-execution.ts";

const commandOptions = {
  cwd: process.cwd(),
  timeoutMs: 5_000,
  maxBufferBytes: 8192,
};

describe("executeLocalCommand", () => {
  it("preserves output and accepts configured nonzero exit codes", async () => {
    const result = await executeLocalCommand(
      process.execPath,
      [
        "-e",
        "console.log('output'); console.error('warning'); process.exitCode = 7",
      ],
      { ...commandOptions, acceptedExitCodes: [7] },
    );
    expect(result).toEqual({
      stdout: "output",
      stderr: "warning",
      exitCode: 7,
    });
  });
  it("rejects unaccepted exit codes with captured output", async () => {
    await expect(
      executeLocalCommand(
        process.execPath,
        ["-e", "console.log('partial'); process.exitCode = 7"],
        commandOptions,
      ),
    ).rejects.toMatchObject({ code: 7, stdout: "partial\n" });
  });
  it("reports timeouts separately from cancellation and spawn errors", async () => {
    await expect(
      executeLocalCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { ...commandOptions, timeoutMs: 300, acceptedExitCodes: [0, 1] },
      ),
    ).rejects.toMatchObject({ timedOut: true, timeoutMs: 300 });
    await expect(
      executeLocalCommand(
        "machdoch-nonexistent-test-executable",
        [],
        commandOptions,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("passes environment overrides to the child", async () => {
    const result = await executeLocalCommand(
      process.execPath,
      ["-e", "console.log(process.env.MACHDOCH_COMMAND_TEST)"],
      {
        ...commandOptions,
        env: { ...process.env, MACHDOCH_COMMAND_TEST: "passed" },
      },
    );
    expect(result.stdout).toBe("passed");
  });
  it("formats timeout details distinctly from ordinary command failures", () => {
    const error = Object.assign(new Error("Command failed: pnpm test"), {
      stdout: "partial stdout\r\n",
      stderr: "",
      timedOut: true,
      timeoutMs: 120_000,
      signal: "SIGTERM",
    });
    expect(getLocalCommandErrorDetails(error)).toEqual({
      stdout: "partial stdout",
      stderr: "",
      signal: "SIGTERM",
      timedOut: true,
      timeoutMs: 120_000,
    });
    expect(
      formatLocalCommandError("Run Verification failed.", error),
    ).toContain("timed out after 120000ms");
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
      normalizeLocalCommandCwd("\\\\?\\UNC\\server\\share\\machdoch", "win32"),
    ).toBe("\\\\server\\share\\machdoch");
  });

  it("converts Windows UNC prefixes case-insensitively", () => {
    expect(
      normalizeLocalCommandCwd("\\\\?\\unc\\server\\share\\machdoch", "win32"),
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
      normalizeLocalCommandCwd("\\\\.\\UNC\\server\\share\\machdoch", "win32"),
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
