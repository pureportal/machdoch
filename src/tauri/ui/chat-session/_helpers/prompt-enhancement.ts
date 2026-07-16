import {
  isMediaAssetContextAttachment,
  type ChatSessionContextAttachment,
} from "../../chat-session.model";

export const PROMPT_ENHANCEMENT_MODES = [
  "off",
  "simple",
  "web-search",
] as const;

export type PromptEnhancementMode = (typeof PROMPT_ENHANCEMENT_MODES)[number];

export type ActivePromptEnhancementMode = Exclude<
  PromptEnhancementMode,
  "off"
>;

export const PROMPT_ENHANCEMENT_LABELS = {
  off: "Off",
  simple: "Simple enhance",
  "web-search": "Enhance with web search",
} satisfies Record<PromptEnhancementMode, string>;

const ENHANCED_PROMPT_TAG_PATTERN =
  /<machdoch_enhanced_prompt>\s*([\s\S]*?)\s*<\/machdoch_enhanced_prompt>/iu;

const formatAttachmentKind = (attachment: ChatSessionContextAttachment): string => {
  switch (attachment.kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "image":
      return "image";
    case "other":
    default:
      return "path";
  }
};

const formatAttachmentLine = (
  attachment: ChatSessionContextAttachment,
): string | null => {
  if (isMediaAssetContextAttachment(attachment)) {
    return `- Attached Media Studio ${attachment.kind} (${attachment.name.trim()}): asset ${attachment.assetId}`;
  }
  const path = attachment.path.trim();

  if (!path) {
    return null;
  }

  const name = attachment.name.trim();
  const displayName = name && name !== path ? ` (${name})` : "";

  return `- Attached ${formatAttachmentKind(attachment)}${displayName}: ${path}`;
};

const stripMarkdownFence = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```[a-z0-9_-]*\s*([\s\S]*?)\s*```$/iu);

  return fenced?.[1]?.trim() ?? trimmed;
};

const stripPromptLabel = (value: string): string => {
  return value.replace(
    /^(?:enhanced\s+prompt|improved\s+prompt|prompt)\s*:\s*/iu,
    "",
  );
};

export const createPromptEnhancementTask = (input: {
  mode: ActivePromptEnhancementMode;
  prompt: string;
  contextAttachments: readonly ChatSessionContextAttachment[];
}): string => {
  const attachmentLines = input.contextAttachments
    .map(formatAttachmentLine)
    .filter((line): line is string => Boolean(line));
  const usesWebSearch = input.mode === "web-search";

  return [
    "Enhance the user's Machdoch chat request before any interview or task execution starts.",
    "",
    "Return only the improved request inside these exact tags:",
    "<machdoch_enhanced_prompt>",
    "...enhanced request...",
    "</machdoch_enhanced_prompt>",
    "",
    "Rules:",
    "- Do not answer the request or perform the requested implementation.",
    "- Preserve the user's intent, language, constraints, scope, and explicit uncertainty.",
    "- Do not invent hard requirements, file paths, APIs, or acceptance criteria that the user did not imply.",
    "- Make the request clearer and more actionable for a downstream autonomous coding agent.",
    "- Add useful structure such as objective, scope, constraints, context to inspect, acceptance criteria, and verification guidance when it helps.",
    "- If the original request is already precise, keep the rewrite close to the original and improve only wording and missing execution details.",
    usesWebSearch
      ? "- Use focused web search when current external facts, API behavior, compatibility, security guidance, or comparable product context would materially improve the request. Include concise source URLs in the enhanced request only when they affect execution."
      : "- Do not use web search or fetch external URLs. Base the rewrite only on the request, chat context, and attached local context.",
    "",
    "Original user request:",
    input.prompt.trim(),
    "",
    "Current context attachments:",
    ...(attachmentLines.length > 0 ? attachmentLines : ["- None"]),
  ].join("\n");
};

export const extractEnhancedPrompt = (value: string): string => {
  const tagged = value.match(ENHANCED_PROMPT_TAG_PATTERN)?.[1];
  const candidate = stripPromptLabel(stripMarkdownFence(tagged ?? value));

  return candidate.trim();
};
