import { z } from "zod";

export const modelProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "langdock",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
]);
export const runModeSchema = z.enum(["ask", "machdoch"]);
export const reasoningModeSchema = z.enum([
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "aeon",
]);
export const promptEnhancementModeSchema = z.enum(["off", "simple", "web-search"]);

export type RuntimeProvider = z.infer<typeof modelProviderSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type ReasoningMode = z.infer<typeof reasoningModeSchema>;
export type PromptEnhancementMode = z.infer<typeof promptEnhancementModeSchema>;
