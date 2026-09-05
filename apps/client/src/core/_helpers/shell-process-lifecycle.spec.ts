/// <reference types="vitest/globals" />
import { tmpdir } from "node:os";
import { runStreamingCommand as runStreamingShellCommand } from "./streaming-command.ts";

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("shell process lifecycle with real children", () => {
  it("times out and reaps a process tree that keeps both pipes open", async () => {
    let descendantPid: number | undefined;
    const script = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
      console.log('DESCENDANT:' + child.pid);
      setInterval(() => {}, 1000);
    `;
    try {
      await expect(
        runStreamingShellCommand(process.execPath, ["-e", script], {
          cwd: tmpdir(),
          timeoutMs: 1_500,
          maxBufferBytes: 8192,
          onOutput: ({ chunk }) => {
            const pid = /DESCENDANT:(\d+)/u.exec(chunk)?.[1];
            if (pid) descendantPid = Number(pid);
          },
        }),
      ).rejects.toThrow("timed out");
      expect(descendantPid).toBeDefined();
      await vi.waitFor(
        () => expect(processExists(descendantPid!)).toBe(false),
        { timeout: 3_000 },
      );
    } finally {
      if (descendantPid && processExists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "escalates cancellation when SIGTERM is ignored",
    async () => {
      const controller = new AbortController();
      const result = runStreamingShellCommand(
        process.execPath,
        [
          "-e",
          `
      process.on('SIGTERM', () => {});
      console.log('READY');
      setInterval(() => {}, 1000);
    `,
        ],
        {
          cwd: tmpdir(),
          timeoutMs: 5_000,
          maxBufferBytes: 8192,
          signal: controller.signal,
          onOutput: () => controller.abort("cancel stubborn process"),
        },
      );
      await expect(result).rejects.toThrow("cancel stubborn process");
    },
  );

  it("drains all output from a successful process before settling", async () => {
    const result = await runStreamingShellCommand(
      process.execPath,
      [
        "-e",
        `
      process.stdout.write('x'.repeat(256 * 1024));
      process.stderr.write('tail-marker');
    `,
      ],
      { cwd: tmpdir(), timeoutMs: 5_000, maxBufferBytes: 512 * 1024 },
    );
    expect(result.stdout).toHaveLength(256 * 1024);
    expect(result.stderr).toBe("tail-marker");
    expect(result.exitCode).toBe(0);
  });

  it("bounds retained output when a process floods its pipes", async () => {
    const result = runStreamingShellCommand(
      process.execPath,
      [
        "-e",
        `
      setInterval(() => process.stdout.write('x'.repeat(8192)), 1);
    `,
      ],
      { cwd: tmpdir(), timeoutMs: 5_000, maxBufferBytes: 1024 },
    );
    await expect(result).rejects.toMatchObject({ stdout: "x".repeat(1024) });
    await expect(result).rejects.toThrow("output exceeded");
  });
});
