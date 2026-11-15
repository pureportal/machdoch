import { z } from "zod";

export const contextWindowSchema = z.enum(["lowest", "default", "highest"]);
export type ContextWindow = z.infer<typeof contextWindowSchema>;
export const DEFAULT_CONTEXT_WINDOW: ContextWindow = "default";
export const CONTEXT_WINDOW_LABELS: Record<ContextWindow, string> = {
  lowest: "Lowest",
  default: "Standard",
  highest: "Highest",
};
const AUTO_COMPACT_TOKENS = {
  lowest: 200_000,
  default: 400_000,
} as const;
const PROVIDER_COMPACTION_SHARE = 0.8;
const CLAUDE_CLI_CONTEXT_TOKENS = 1_000_000;
const CLAUDE_CLI_STANDARD_CONTEXT_TOKENS = 200_000;
const COMPACTING_PROVIDERS = new Set(["claude-cli", "codex-cli", "copilot-cli"]);

export interface ContextWindowModelCapabilities {
  contextWindowTokens?: number | null;
  longContextWindowTokens?: number | null;
}

export interface ContextWindowCapabilities {
  kind: "fixed" | "numeric" | "tiered";
  defaultTokens: number | null;
  highestTokens: number | null;
  compacts: boolean;
}

const validTokenCount = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

export function contextWindowCapabilities(
  provider: string | null | undefined,
  model: string | null | undefined,
  discovered?: ContextWindowModelCapabilities,
): ContextWindowCapabilities {
  const name = model?.trim().toLowerCase() ?? "";
  const compacts = COMPACTING_PROVIDERS.has(provider ?? "");
  const defaultTokens = validTokenCount(discovered?.contextWindowTokens);
  const fixed: ContextWindowCapabilities = {
    kind: "fixed",
    defaultTokens,
    highestTokens: defaultTokens,
    compacts,
  };
  if (!name) return fixed;
  if (provider === "claude-cli") {
    if (validTokenCount(discovered?.longContextWindowTokens) !== null)
      return {
        kind: "tiered",
        defaultTokens: CLAUDE_CLI_STANDARD_CONTEXT_TOKENS,
        highestTokens: CLAUDE_CLI_CONTEXT_TOKENS,
        compacts,
      };
    const tokens = defaultTokens ?? CLAUDE_CLI_CONTEXT_TOKENS;
    return { ...fixed, defaultTokens: tokens, highestTokens: tokens };
  }
  // `codex debug models` reports each model's default and maximum window.
  if (provider === "codex-cli") {
    const maximum = validTokenCount(
      discovered?.longContextWindowTokens ?? discovered?.contextWindowTokens,
    );
    if (
      maximum === null ||
      maximum > 10_000_000 ||
      (defaultTokens !== null && maximum <= defaultTokens)
    )
      return fixed;
    return { ...fixed, kind: "numeric", highestTokens: maximum };
  }
  const longTokens =
    provider === "copilot-cli"
      ? validTokenCount(discovered?.longContextWindowTokens)
      : null;
  if (
    longTokens === null ||
    (defaultTokens !== null && longTokens <= defaultTokens)
  )
    return fixed;
  return { ...fixed, kind: "tiered", highestTokens: longTokens };
}

export function autoCompactTokens(
  value: ContextWindow,
  supported: ContextWindowCapabilities,
): number | null {
  if (
    value === "highest" ||
    !supported.compacts ||
    supported.defaultTokens === null
  )
    return null;
  const limit = AUTO_COMPACT_TOKENS[value];
  return limit < supported.defaultTokens * PROVIDER_COMPACTION_SHARE
    ? limit
    : null;
}

export function contextWindowTokens(
  value: ContextWindow,
  supported: ContextWindowCapabilities,
): number | null {
  if (value === "highest") return supported.highestTokens;
  return autoCompactTokens(value, supported) ?? supported.defaultTokens;
}

export function isContextWindowAdjustable(
  supported: ContextWindowCapabilities,
): boolean {
  const sizes = contextWindowSchema.options.map((value) =>
    contextWindowTokens(value, supported),
  );
  return sizes.every((size) => size !== null) && new Set(sizes).size > 1;
}

export function resolveProviderContextWindow(
  value: ContextWindow,
  supported: ContextWindowCapabilities,
): "default" | "long" | number {
  if (value !== "highest" || supported.kind === "fixed") return "default";
  if (supported.kind === "tiered") return "long";
  return supported.highestTokens ?? "default";
}
