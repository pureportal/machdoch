export const PROMPT_ENHANCEMENT_MODES = [
  "off",
  "simple",
  "web-search",
] as const;

export type PromptEnhancementMode = (typeof PROMPT_ENHANCEMENT_MODES)[number];

export const PROMPT_ENHANCEMENT_LABELS = {
  off: "Off",
  simple: "Simple enhance",
  "web-search": "Enhance with web search",
} satisfies Record<PromptEnhancementMode, string>;
