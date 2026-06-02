import { resolveToolPolicies } from "./policy.ts";
import { getToolRegistry } from "./tools.ts";
import type {
  ProviderAvailability,
  RunMode,
  RuntimeConfig,
} from "./types.ts";

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createConfig = (mode: RunMode): RuntimeConfig => {
  return {
    workspaceRoot: "C:/workspace",
    mode,
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
    const policies = resolveToolPolicies(createConfig("ask"));

    expect(policies).toHaveLength(getToolRegistry().length);
    expect(
      policies.find((policy) => policy.tool.name === "filesystem")?.decision,
    ).toBe("allow");
    expect(
      policies.find((policy) => policy.tool.name === "shell")?.decision,
    ).toBe("allow");
  });

  it("allows high-level tool categories in ask mode while describing the read-only function-call surface", () => {
    const policies = resolveToolPolicies(
      createConfig("ask"),
      ["filesystem", "shell", "network", "git", "utilities"],
    );

    expect(
      Object.fromEntries(
        policies.map((policy) => [policy.tool.name, policy.decision]),
      ),
    ).toEqual({
      filesystem: "allow",
      shell: "allow",
      network: "allow",
      git: "allow",
      utilities: "allow",
    });
    expect(policies[0]?.reason).toContain("read-only function calls");
  });

  it("allows all high-level tool categories in machdoch mode", () => {
    const policies = resolveToolPolicies(
      createConfig("machdoch"),
      ["filesystem", "network", "utilities", "git"],
    );

    expect(
      Object.fromEntries(
        policies.map((policy) => [policy.tool.name, policy.decision]),
      ),
    ).toEqual({
      filesystem: "allow",
      network: "allow",
      utilities: "allow",
      git: "allow",
    });
    expect(policies[0]?.reason).toContain("Machdoch mode");
  });
});
