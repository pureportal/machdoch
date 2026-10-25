import { z } from "zod";

export const contextWindowSchema = z.enum(["lowest", "default", "highest"]);
export type ContextWindow = z.infer<typeof contextWindowSchema>;
export const DEFAULT_CONTEXT_WINDOW: ContextWindow = "highest";
export const CONTEXT_WINDOW_LABELS: Record<ContextWindow, string> = {
  lowest: "Lowest",
  default: "Provider Default",
  highest: "Highest",
};

export interface ContextWindowModelCapabilities {
  contextWindowTokens?: number | null;
  longContextWindowTokens?: number | null;
}

export interface ContextWindowCapabilities {
  kind: "fixed" | "numeric" | "tiered";
  defaultTokens: number | null;
  lowestTokens: number | null;
  highestTokens: number | null;
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
  const defaultTokens = validTokenCount(discovered?.contextWindowTokens);
  const fixed: ContextWindowCapabilities = {
    kind: "fixed",
    defaultTokens,
    lowestTokens: defaultTokens,
    highestTokens: defaultTokens,
  };
  if (!name) return fixed;
  const knownCodex =
    /^gpt-(?:6-astra|5\.6(?:-(?:sol|terra|luna))?|5\.5(?:-pro)?|5\.4(?:-(?:pro|mini|nano))?)(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      name,
    );
  if (provider === "codex-cli") {
    const maximum = validTokenCount(
      discovered?.longContextWindowTokens ??
        discovered?.contextWindowTokens ??
        (knownCodex
          ? /^gpt-(?:5\.[456](?!-(?:mini|nano))|6(?:\.1)?-(?:astra|sol))/u.test(
              name,
            )
            ? 1_050_000
            : 400_000
          : null),
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
      : provider === "claude-cli" &&
          /^(?:(?:sonnet|opus)(?:\[1m\])?|claude-(?:sonnet|opus)-4-6(?:-\d{8})?(?:\[1m\])?)$/u.test(
            name,
          )
        ? 1_000_000
        : null;
  if (
    longTokens === null ||
    (defaultTokens !== null && longTokens <= defaultTokens)
  )
    return fixed;
  return { ...fixed, kind: "tiered", highestTokens: longTokens };
}

export function contextWindowTokens(
  value: ContextWindow,
  supported: ContextWindowCapabilities,
): number | null {
  switch (value) {
    case "lowest":
      return supported.lowestTokens;
    case "default":
      return supported.defaultTokens;
    case "highest":
      return supported.highestTokens;
  }
}

export function resolveProviderContextWindow(
  value: ContextWindow,
  supported: ContextWindowCapabilities,
): "default" | "long" | number {
  if (supported.kind === "fixed" || value === "default") return "default";
  if (supported.kind === "tiered")
    return value === "highest" ? "long" : "default";
  return contextWindowTokens(value, supported) ?? "default";
}
