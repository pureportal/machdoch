import type { ChatSessionContextAttachment } from "./model";

const getLinkAttachmentName = (value: string): string => {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    const label = `${url.hostname}${path}`.trim();

    return label || url.protocol.replace(/:$/u, "") || value;
  } catch {
    return value.split(/\s+/u).filter(Boolean).at(0) ?? value;
  }
};

export const createContextAttachmentFromReference = (
  value: string,
): ChatSessionContextAttachment | null => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    source: "path",
    path: normalizedValue,
    kind: "other",
    name: getLinkAttachmentName(normalizedValue),
  };
};
