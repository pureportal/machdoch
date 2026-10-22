import { z } from "zod";

export const contextWindowSchema = z.union([
  z.enum(["default", "long"]),
  z.number().int().min(1).max(10_000_000),
]);
export type ContextWindow = z.infer<typeof contextWindowSchema>;
export interface ContextWindowModelCapabilities {
  contextWindowTokens?: number | null;
  longContextWindowTokens?: number | null;
}

export type ContextWindowCapabilities =
  | { kind: "fixed" }
  | {
      kind: "range";
      minimum: number;
      maximum: number;
      step: number;
      defaultTokens: number | null;
    }
  | { kind: "presets"; defaultTokens: number | null; longTokens: number };

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
  if (!name) return { kind: "fixed" };
  const knownCodex =
    /^gpt-(?:6-astra|5\.6(?:-(?:sol|terra|luna))?|5\.5(?:-pro)?|5\.4(?:-(?:pro|mini|nano))?)(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      name,
    );
  const maximum =
    (provider === "codex-cli"
      ? discovered?.longContextWindowTokens
      : undefined) ??
    discovered?.contextWindowTokens ??
    (knownCodex
      ? /^gpt-(?:5\.[456](?!-(?:mini|nano))|6(?:\.1)?-(?:astra|sol))/u.test(
          name,
        )
        ? 1_050_000
        : 400_000
      : null);
  const defaultTokens = validTokenCount(discovered?.contextWindowTokens);
  const numericMaximum = validTokenCount(maximum);
  if (provider === "codex-cli" && numericMaximum !== null) {
    return {
      kind: "range",
      minimum: 1,
      maximum: Math.min(numericMaximum, 10_000_000),
      step: 1,
      defaultTokens,
    };
  }
  if (provider === "copilot-cli") {
    const longTokens = validTokenCount(discovered?.longContextWindowTokens);
    if (longTokens !== null)
      return { kind: "presets", defaultTokens, longTokens };
  }
  if (
    provider === "claude-cli" &&
    /^(?:(?:sonnet|opus)(?:\[1m\])?|claude-(?:sonnet|opus)-4-6(?:-\d{8})?(?:\[1m\])?)$/u.test(
      name,
    )
  ) {
    return { kind: "presets", defaultTokens, longTokens: 1_000_000 };
  }
  return { kind: "fixed" };
}
