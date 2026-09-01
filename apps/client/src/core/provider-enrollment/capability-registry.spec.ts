import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { probeProviderCli } from "./capability-registry.js";

describe("provider capability registry", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("retries a transiently incomplete help probe before deciding features are missing", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex --config <key=value>",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex exec --json",
        stderr: "",
      });

    const result = await probeProviderCli(
      "codex-cli",
      "C:\\tools\\transient-codex.exe",
      { force: true },
    );

    expect(result.available).toBe(true);
    expect(result.features).toContain("--config");
    expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--help"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("retries a transiently incomplete version probe", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex --config <key=value>",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex exec --json",
        stderr: "",
      });

    const result = await probeProviderCli(
      "codex-cli",
      "C:\\tools\\transient-version-codex.exe",
      { force: true },
    );

    expect(result.version).toBe("codex-cli 1.0.0");
    expect(result.features).toEqual(["--config", "--json"]);
    expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("does not retry a completed help probe that genuinely lacks required flags", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex exec",
        stderr: "",
      });

    const result = await probeProviderCli(
      "codex-cli",
      "C:\\tools\\unsupported-codex.exe",
      { force: true },
    );

    expect(result.available).toBe(true);
    expect(result.features).not.toContain("--config");
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it("discovers Copilot attachment, reasoning, and context controls from help output", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "copilot 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          "Usage: copilot --stream --output-format <format> --attachment <path> --effort <level> --context <mode>",
        stderr: "",
      });

    const result = await probeProviderCli(
      "copilot-cli",
      "C:\\tools\\copilot.exe",
      { force: true },
    );

    expect(result.features).toEqual([
      "--attachment",
      "--context",
      "--effort",
      "--output-format",
      "--stream",
    ]);
  });

  it("discovers Codex structured output from exec subcommand help", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "codex-cli 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex --config <key=value>",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "Usage: codex exec --json",
        stderr: "",
      });

    const result = await probeProviderCli("codex-cli", "C:\\tools\\codex.exe", {
      force: true,
    });

    expect(result.features).toEqual(["--config", "--json"]);
    expect(spawnSyncMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("discovers Claude structured terminal-result controls", async () => {
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "claude-cli 1.0.0",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          "Usage: claude --append-system-prompt-file --output-format --verbose",
        stderr: "",
      });

    const result = await probeProviderCli(
      "claude-cli",
      "C:\\tools\\claude.exe",
      { force: true },
    );

    expect(result.features).toEqual([
      "--append-system-prompt-file",
      "--output-format",
      "--verbose",
    ]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});
