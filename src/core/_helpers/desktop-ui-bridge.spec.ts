/// <reference types="vitest/globals" />

const { execFileAsyncMock, execFileMock, unlinkMock, writeFileMock } =
  vi.hoisted(() => {
    const execFileAsyncMock = vi.fn();
    const execFileMock = vi.fn();

    Object.defineProperty(
      execFileMock,
      Symbol.for("nodejs.util.promisify.custom"),
      {
        value: execFileAsyncMock,
      },
    );

    return {
      execFileAsyncMock,
      execFileMock,
      unlinkMock: vi.fn(),
      writeFileMock: vi.fn(),
    };
  });

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFile: execFileMock,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    unlink: unlinkMock,
    writeFile: writeFileMock,
  };
});

import type { UiControlRuntimeInfo } from "../types.ts";
import { executeDesktopUiBridge } from "./desktop-ui-bridge.ts";

const uiControl: UiControlRuntimeInfo = {
  available: true,
  platform: "windows",
  bridgeCommand: "machdoch.exe",
  supportsWindowEnumeration: true,
  supportsWindowHandles: true,
};

beforeEach(() => {
  execFileAsyncMock.mockResolvedValue({
    stdout: JSON.stringify({ ok: true, data: { value: 42 } }),
    stderr: "",
  });
  unlinkMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
});

afterEach(() => {
  execFileAsyncMock.mockReset();
  execFileMock.mockReset();
  unlinkMock.mockReset();
  writeFileMock.mockReset();
});

describe("executeDesktopUiBridge", () => {
  it("runs the bridge with a timeout and cleans up the request file", async () => {
    await expect(
      executeDesktopUiBridge(uiControl, "list_windows"),
    ).resolves.toEqual({ value: 42 });

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      "machdoch.exe",
      [
        "--ui-control-bridge-request-file",
        expect.stringContaining("machdoch-ui-control-"),
      ],
      expect.objectContaining({
        maxBuffer: 50_000_000,
        timeout: 60_000,
        windowsHide: true,
      }),
    );
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringContaining("machdoch-ui-control-"),
    );
  });

  it("does not accept successful stdout when the bridge process fails", async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("bridge timed out"), {
        stdout: JSON.stringify({ ok: true, data: { value: 42 } }),
        stderr: "",
      }),
    );

    await expect(
      executeDesktopUiBridge(uiControl, "list_windows"),
    ).rejects.toThrow("bridge timed out");
    expect(unlinkMock).toHaveBeenCalledWith(
      expect.stringContaining("machdoch-ui-control-"),
    );
  });

  it("preserves structured bridge errors emitted before process failure", async () => {
    execFileAsyncMock.mockRejectedValue(
      Object.assign(new Error("bridge exited with 1"), {
        stdout: JSON.stringify({ ok: false, error: "native bridge failed" }),
        stderr: "fallback stderr",
      }),
    );

    await expect(
      executeDesktopUiBridge(uiControl, "list_windows"),
    ).rejects.toThrow("native bridge failed");
  });
});
