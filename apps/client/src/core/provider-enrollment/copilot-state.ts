const COPILOT_ISOLATED_STATE_EXCLUDED_KEYS = new Set([
  "installedPlugins",
  "enabledPlugins",
  "extraKnownMarketplaces",
]);

const stripJsonComments = (value: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const next = value[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        blockComment = false;
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      blockComment = true;
      continue;
    }
    result += character;
  }

  if (blockComment) {
    throw new Error("Copilot internal state contains an unterminated comment.");
  }
  return result;
};

const stripTrailingCommas = (value: string): string => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/u.test(value[nextIndex] ?? "")) nextIndex += 1;
      if (value[nextIndex] === "}" || value[nextIndex] === "]") {
        result += " ";
        continue;
      }
    }
    result += character;
  }
  return result;
};

export const renderIsolatedCopilotState = (content: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      stripTrailingCommas(
        stripJsonComments(content.replace(/^\uFEFF/u, " ")),
      ),
    );
  } catch (error) {
    throw new Error(
      "Copilot internal state must be a valid JSON-with-comments object before authentication state can be isolated.",
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Copilot internal state must be a valid JSON-with-comments object before authentication state can be isolated.",
    );
  }

  const isolated = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    if (!COPILOT_ISOLATED_STATE_EXCLUDED_KEYS.has(key)) isolated[key] = value;
  }
  return `${JSON.stringify(isolated, null, 2)}\n`;
};
