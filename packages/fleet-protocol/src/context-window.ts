import { z } from "zod";

export const contextWindowSchema = z.union([
  z.enum(["default", "long"]),
  z.number().int().min(1).max(10_000_000),
]);
export type ContextWindow = z.infer<typeof contextWindowSchema>;
export interface ContextWindowCapabilities {
  numericMaximum: number | null;
  long: boolean;
}

export function contextWindowCapabilities(
  provider: string | null | undefined,
  model: string | null | undefined,
  discovered?: {
    contextWindowTokens?: number | null;
    longContextWindowTokens?: number | null;
  },
): ContextWindowCapabilities {
  const name = model?.trim().toLowerCase() ?? "";
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
  return {
    numericMaximum:
      provider === "codex-cli" && typeof maximum === "number" && maximum > 0
        ? maximum
        : null,
    long:
      provider === "copilot-cli"
        ? typeof discovered?.longContextWindowTokens === "number" &&
          discovered.longContextWindowTokens > 0
        : provider === "claude-cli" &&
          /^(?:(?:sonnet|opus)(?:\[1m\])?|claude-(?:sonnet|opus)-4-6(?:-\d{8})?(?:\[1m\])?)$/u.test(
            name,
          ),
  };
}
