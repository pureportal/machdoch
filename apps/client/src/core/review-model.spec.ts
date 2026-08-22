import { resolveReviewModelRuntimeConfig } from "./review-model.ts";
import type { RuntimeConfig } from "./runtime-contract.generated.ts";

const createConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig =>
  ({
    provider: "openai",
    model: "gpt-5.5",
    ...overrides,
  }) as RuntimeConfig;

describe("resolveReviewModelRuntimeConfig", () => {
  it("uses the dedicated review model provider and trimmed model", () => {
    const config = createConfig({
      reviewModel: {
        mode: "dedicated",
        provider: "anthropic",
        model: "  claude-opus-4-8  ",
      },
    });

    expect(resolveReviewModelRuntimeConfig(config)).toEqual({
      ...config,
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it.each([
    ["missing review model", {}],
    ["auto mode", { reviewModel: { mode: "auto" } }],
    ["missing provider", { reviewModel: { mode: "dedicated", model: "review" } }],
    ["blank model", { reviewModel: { mode: "dedicated", provider: "openai", model: "   " } }],
  ])("returns the original config for %s", (_label, overrides) => {
    const config = createConfig(overrides as Partial<RuntimeConfig>);

    expect(resolveReviewModelRuntimeConfig(config)).toBe(config);
  });
});
