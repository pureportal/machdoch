/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probeCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../_helpers/streaming-command.js", () => ({
  runStreamingCommand: async (...args: unknown[]) => {
    const result = await probeCommandMock(...args);
    if (result.error)
      throw Object.assign(result.error, {
        stdout: result.stdout,
        stderr: result.stderr,
      });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
    };
  },
}));

import { probeProviderCli } from "./capability-registry.js";

describe("provider capability registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    probeCommandMock.mockReset();
  });

  it("coalesces forced concurrent probes and isolates cached results from mutation", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    probeCommandMock.mockImplementation(async () => {
      await blocked;
      return { status: 0, stdout: "--config --json", stderr: "" };
    });
    const first = probeProviderCli("codex-cli", "coalesced-probe.exe", {
      force: true,
    });
    await vi.waitFor(() => expect(probeCommandMock).toHaveBeenCalledTimes(1));
    const second = probeProviderCli("codex-cli", "coalesced-probe.exe", {
      force: true,
    });
    // Let the asynchronous executable metadata read reach the pending cache.
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(probeCommandMock).toHaveBeenCalledTimes(3);
    a.features.length = 0;
    b.warnings.push("caller edit");
    const cached = await probeProviderCli("codex-cli", "coalesced-probe.exe");
    expect(cached.features).toEqual(["--config", "--json"]);
    expect(cached.warnings).toEqual([]);
    expect(probeCommandMock).toHaveBeenCalledTimes(3);
  });

  it("limits command concurrency across different CLI probes to two", async () => {
    let active = 0;
    let maximum = 0;
    probeCommandMock.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { status: 0, stdout: "--output-format", stderr: "" };
    });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        probeProviderCli("claude-cli", `concurrent-${i}.exe`, { force: true }),
      ),
    );
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(probeCommandMock).toHaveBeenCalledTimes(12);
  });

  it("invalidates cached capabilities when the executable changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-probe-cache-"));
    const executable = join(root, "provider.exe");
    try {
      await writeFile(executable, "version one");
      probeCommandMock.mockReturnValue({
        status: 0,
        stdout: "--config",
        stderr: "",
      });
      await probeProviderCli("codex-cli", executable);
      await probeProviderCli("codex-cli", executable);
      expect(probeCommandMock).toHaveBeenCalledTimes(3);
      await writeFile(executable, "replacement version two");
      probeCommandMock.mockReturnValue({
        status: 0,
        stdout: "--config --json",
        stderr: "",
      });
      expect(
        (await probeProviderCli("codex-cli", executable)).features,
      ).toEqual(["--config", "--json"]);
      expect(probeCommandMock).toHaveBeenCalledTimes(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries unavailable executables after the shorter negative-cache TTL", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    probeCommandMock.mockReturnValue({ status: null, stdout: "", stderr: "" });
    expect(
      (await probeProviderCli("claude-cli", "missing-cache.exe")).available,
    ).toBe(false);
    await probeProviderCli("claude-cli", "missing-cache.exe");
    expect(probeCommandMock).toHaveBeenCalledTimes(4);
    now += 15_001;
    probeCommandMock.mockReturnValue({
      status: 0,
      stdout: "--output-format",
      stderr: "",
    });
    expect(
      (await probeProviderCli("claude-cli", "missing-cache.exe")).available,
    ).toBe(true);
    expect(probeCommandMock).toHaveBeenCalledTimes(6);
  });

  it.runIf(process.platform === "win32")(
    "quotes Windows wrappers with spaces",
    async () => {
      probeCommandMock.mockReturnValue({
        status: 0,
        stdout: "--output-format",
        stderr: "",
      });
      await probeProviderCli("claude-cli", "C:\\Program Files\\provider.cmd");
      expect(probeCommandMock).toHaveBeenCalledWith(
        '"C:\\Program Files\\provider.cmd" --version',
        [],
        expect.objectContaining({ shell: true }),
      );
    },
  );

  it("retries a transiently incomplete help probe before deciding features are missing", async () => {
    probeCommandMock
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
    expect(probeCommandMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--help"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("retries a transiently incomplete version probe", async () => {
    probeCommandMock
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
    expect(probeCommandMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("does not retry a completed help probe that genuinely lacks required flags", async () => {
    probeCommandMock
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
    expect(probeCommandMock).toHaveBeenCalledTimes(3);
  });

  it("discovers Copilot attachment, reasoning, and context controls from help output", async () => {
    probeCommandMock
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
    probeCommandMock
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
    expect(probeCommandMock.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("discovers Claude structured terminal-result controls", async () => {
    probeCommandMock
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
    expect(probeCommandMock).toHaveBeenCalledTimes(2);
  });
});
