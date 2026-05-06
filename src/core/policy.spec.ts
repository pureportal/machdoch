import { resolveToolPolicies } from "./policy.ts";
import { getToolRegistry } from "./tools.ts";
import type {
  ProviderAvailability,
  RunMode,
  RuntimeConfig,
  ToolName,
} from "./types.ts";

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createConfig = (
  mode: RunMode,
  enabledTools: ToolName[],
): RuntimeConfig => {
  return {
    workspaceRoot: "C:/workspace",
    mode,
    enabledTools,
    provider: "unconfigured",
    model: "gpt-5.5",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability,
    webSearch: {
      activeProvider: "none",
      providerAvailability: [
        { provider: "perplexity", configured: false },
        { provider: "tavily", configured: false },
      ],
    },
    availableProfiles: [],
  };
};

describe("resolveToolPolicies", () => {
  it("returns policies for the full registry when no focus tools are provided", () => {
    const policies = resolveToolPolicies(createConfig("ask", ["filesystem"]));

    expect(policies).toHaveLength(getToolRegistry().length);
    expect(
      policies.find((policy) => policy.tool.name === "filesystem")?.decision,
    ).toBe("allow");
    expect(
      policies.find((policy) => policy.tool.name === "shell")?.decision,
    ).toBe("blocked");
  });

  it("uses risk-aware approvals in ask mode", () => {
    const policies = resolveToolPolicies(
      createConfig("ask", ["filesystem", "shell", "network", "utilities"]),
      ["filesystem", "shell", "network", "git", "utilities"],
    );

    expect(
      Object.fromEntries(
        policies.map((policy) => [policy.tool.name, policy.decision]),
      ),
    ).toEqual({
      filesystem: "allow",
      shell: "ask",
      network: "ask",
      git: "blocked",
      utilities: "allow",
    });
  });

  it("requires approval for every enabled tool in safe mode and allows enabled tools in auto mode", () => {
    const safePolicies = resolveToolPolicies(
      createConfig("safe", ["filesystem", "git"]),
      ["filesystem", "git"],
    );
    const autoPolicies = resolveToolPolicies(
      createConfig("auto", ["filesystem", "git"]),
      ["filesystem", "git"],
    );

    expect(safePolicies.map((policy) => policy.decision)).toEqual([
      "ask",
      "ask",
    ]);
    expect(autoPolicies.map((policy) => policy.decision)).toEqual([
      "allow",
      "allow",
    ]);
  });
});
