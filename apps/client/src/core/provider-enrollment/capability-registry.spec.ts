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

  it("retains the OS launch reason when the CLI is unavailable", async () => {
    probeCommandMock.mockResolvedValue({
      error: Object.assign(new Error("spawn unavailable-provider.exe ENOENT"), {
        code: "ENOENT",
      }),
      stdout: "",
      stderr: "",
    });
    const result = await probeProviderCli(
      "claude-cli",
      "unavailable-provider.exe",
    );
    expect(result.available).toBe(false);
    expect(result.features).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "spawn unavailable-provider.exe ENOENT",
    );
  });

  it("retains timeout and stderr diagnostics without trusting incomplete help", async () => {
    probeCommandMock.mockImplementation(async (_command, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "fixture-cli 1.0.0", stderr: "" }
        : {
            error: Object.assign(
              new Error("Command timed out after 30000ms."),
              { code: "ETIMEDOUT" },
            ),
            stdout: "--append-system-prompt-file --output-format",
            stderr: "provider initialization stalled",
          },
    );
    const result = await probeProviderCli(
      "claude-cli",
      "timed-help-diagnostics.exe",
    );
    expect(result.available).toBe(true);
    expect(result.features).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "Command timed out after 30000ms.",
    );
    expect(result.warnings.join("\n")).toContain(
      "provider initialization stalled",
    );
    probeCommandMock.mockResolvedValue({
      status: 0,
      stdout: "fixture-cli 1.0.0 --append-system-prompt-file --output-format",
      stderr: "",
    });
    const recovered = await probeProviderCli(
      "claude-cli",
      "timed-help-diagnostics.exe",
    );
    expect(recovered.features).toEqual([
      "--append-system-prompt-file",
      "--output-format",
    ]);
    expect(recovered.warnings).toEqual([]);
  });

  it("identifies the failed Codex exec probe and excludes its unverified flags", async () => {
    probeCommandMock.mockImplementation(async (_command, args) =>
      args[0] === "exec"
        ? {
            error: new Error("Codex exec help transport failed"),
            stdout: "--json",
            stderr: "",
          }
        : { status: 0, stdout: "codex-cli 1.0.0 --config --json", stderr: "" },
    );
    const result = await probeProviderCli(
      "codex-cli",
      "failed-exec-help-diagnostics.exe",
    );
    expect(result.features).toEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "Codex exec help probe failed: Codex exec help transport failed",
    );
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

  it("retains verified capabilities across a long agent operation", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    probeCommandMock.mockReturnValue({
      status: 0,
      stdout: "codex-cli 1.0.0 --config --json",
      stderr: "",
    });
    await probeProviderCli("codex-cli", "long-agent-operation.exe");
    now += 6 * 60 * 1_000;
    expect(
      (await probeProviderCli("codex-cli", "long-agent-operation.exe"))
        .features,
    ).toEqual(["--config", "--json"]);
    expect(probeCommandMock).toHaveBeenCalledTimes(3);

    now += 25 * 60 * 1_000;
    await probeProviderCli("codex-cli", "long-agent-operation.exe");
    expect(probeCommandMock).toHaveBeenCalledTimes(6);
  });

  it("rechecks an unavailable executable immediately after recovery", async () => {
    probeCommandMock.mockReturnValue({ status: null, stdout: "", stderr: "" });
    expect(
      (await probeProviderCli("claude-cli", "missing-cache.exe")).available,
    ).toBe(false);
    expect(probeCommandMock).toHaveBeenCalledTimes(4);
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

  it("rechecks incomplete help evidence even when the version probe succeeded", async () => {
    probeCommandMock.mockImplementation(async (_command, args) => ({
      status: args[0] === "--version" ? 0 : null,
      stdout: args[0] === "--version" ? "codex-cli 1.0.0" : "",
      stderr: "",
    }));
    const incomplete = await probeProviderCli(
      "codex-cli",
      "incomplete-help-cache.exe",
    );
    expect(incomplete.available).toBe(true);
    expect(incomplete.features).toEqual([]);
    expect(probeCommandMock).toHaveBeenCalledTimes(5);
    probeCommandMock.mockReturnValue({
      status: 0,
      stdout: "codex-cli 1.0.0 --config --json",
      stderr: "",
    });
    const recovered = await probeProviderCli(
      "codex-cli",
      "incomplete-help-cache.exe",
    );
    expect(recovered.features).toEqual(["--config", "--json"]);
    expect(probeCommandMock).toHaveBeenCalledTimes(8);
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
          "Usage: copilot --stream --output-format <format> --attachment <path> --reasoning-effort <level> --context <mode>",
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
      "--reasoning-effort",
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

  it.each([null, 1])(
    "does not accept instruction flags from unsuccessful help probes (%s)",
    async (status) => {
      probeCommandMock
        .mockReturnValueOnce({
          status: 0,
          stdout: "claude-cli 2.1.283",
          stderr: "",
        })
        .mockReturnValue({
          status,
          stdout:
            "--append-system-prompt-file --mcp-config --setting-sources --strict-mcp-config",
          stderr: "Help probe failed.",
        });

      const result = await probeProviderCli(
        "claude-cli",
        `failed-help-${status}.exe`,
        { force: true },
      );

      expect(result.available).toBe(true);
      expect(result.features).toEqual([]);
      expect(probeCommandMock).toHaveBeenCalledTimes(3);
    },
  );

  it("does not report a provider available when all probes fail", async () => {
    probeCommandMock.mockReturnValue({
      status: 1,
      stdout: "claude-cli 2.1.283 --append-system-prompt-file",
      stderr: "Executable failed.",
    });

    const result = await probeProviderCli("claude-cli", "failed-provider.exe", {
      force: true,
    });

    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.features).toEqual([]);
  });

  it("selects the version line after startup diagnostics", async () => {
    probeCommandMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "WARNING: PATH aliases unavailable.\ncodex-cli 0.159.1",
        stderr: "",
      })
      .mockReturnValue({ status: 0, stdout: "--config --json", stderr: "" });

    const result = await probeProviderCli("codex-cli", "warning-version.exe", {
      force: true,
    });

    expect(result.version).toBe("codex-cli 0.159.1");
  });

  it("discovers Claude subagent instruction file support", async () => {
    probeCommandMock
      .mockReturnValueOnce({
        status: 0,
        stdout: "2.1.283 (Claude Code)",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout:
          "--append-system-prompt-file --append-subagent-system-prompt-file",
        stderr: "",
      });

    const result = await probeProviderCli("claude-cli", "subagent-file.exe", {
      force: true,
    });

    expect(result.features).toEqual([
      "--append-system-prompt-file",
      "--append-subagent-system-prompt-file",
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
