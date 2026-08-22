import type {
  AgentModelToolResult,
  AgentModelToolResultContent,
} from "../../types.js";

export const normalizeToolResultContent = (
  toolResult: AgentModelToolResult,
): AgentModelToolResultContent[] => {
  const normalized: AgentModelToolResultContent[] = [];

  for (const contentPart of toolResult.content ?? []) {
    if (contentPart.type === "text") {
      const text = contentPart.text.trim();

      if (text.length > 0) {
        normalized.push({
          type: "text",
          text,
        });
      }

      continue;
    }

    if (contentPart.data.trim().length > 0) {
      normalized.push(contentPart);
    }
  }

  const normalizedOutput = toolResult.output.trim();
  const hasTextContent = normalized.some(
    (contentPart) => contentPart.type === "text",
  );

  if (!hasTextContent && normalizedOutput.length > 0) {
    normalized.unshift({
      type: "text",
      text: normalizedOutput,
    });
  }

  if (normalized.length > 0) {
    return normalized;
  }

  return normalizedOutput.length > 0
    ? [
        {
          type: "text",
          text: normalizedOutput,
        },
      ]
    : [];
};
