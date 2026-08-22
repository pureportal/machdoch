import type { CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { McpEffectiveServerConfig } from "./types.js";
import { createProviderSamplingHandler } from "./client.js";

const dependencies = vi.hoisted(() => ({
  createProviderAdapter: vi.fn(),
  loadRuntimeConfig: vi.fn(),
}));

vi.mock("../_helpers/provider-adapters.js", () => ({
  createProviderAdapter: dependencies.createProviderAdapter,
}));
vi.mock("../config.js", () => ({
  loadRuntimeConfig: dependencies.loadRuntimeConfig,
}));

const config: RuntimeConfig = {
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-primary",
  reasoning: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [
    { provider: "openai", configured: true },
    { provider: "anthropic", configured: true },
  ],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "anthropic",
    model: "claude-internal",
  },
};

const server: McpEffectiveServerConfig = {
  id: "sampling-server",
  title: "Sampling server",
  enabled: true,
  transport: { type: "stdio", command: "sampling-server" },
  exposure: { mode: "hybrid", directTools: true },
  securityProfile: "weak",
  timeoutMs: 60_000,
  maxTotalTimeoutMs: 300_000,
  idleShutdownMs: 0,
  maxResponseChars: 60_000,
  cache: { enabled: false, ttlMs: 0, forceRefresh: false },
  roots: "workspace",
  sampling: "ask-agent",
  tasks: "optional",
  sources: ["workspace"],
};

const request: CreateMessageRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Summarize the tool result." },
      },
    ],
    maxTokens: 128,
  },
};

describe("MCP sampling model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.loadRuntimeConfig.mockResolvedValue(config);
  });

  it("uses the internal task model instead of the primary runtime model", async () => {
    const startTurn = vi.fn(async () => ({
      text: "Sampled answer",
      toolCalls: [],
      stopReason: "completed",
    }));
    dependencies.createProviderAdapter.mockResolvedValue({
      startTurn,
      continueTurn: vi.fn(),
    });

    await expect(
      createProviderSamplingHandler({
        workspaceRoot: "C:/workspace",
        server,
        request,
      }),
    ).resolves.toMatchObject({
      model: "claude-internal",
      content: { text: "Sampled answer" },
    });

    expect(dependencies.createProviderAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-internal",
      }),
      [],
      undefined,
    );
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-internal" }),
    );
  });
});
