import { normalizeOptionalString } from "../common/_helpers/normalize-optional-string.js";
import type { FrontmatterValue, ParsedMarkdownDocument } from "./types.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Removes matching wrapping quotes from a scalar frontmatter value.
 */
const stripQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
};

/**
 * Parses a scalar or inline-array frontmatter value into a typed value.
 */
const parseScalarValue = (rawValue: string): FrontmatterValue => {
  const trimmed = rawValue.trim();

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();

    if (inner.length === 0) {
      return [];
    }

    return inner
      .split(",")
      .map((part) => stripQuotes(part.trim()))
      .filter((part) => part.length > 0);
  }

  return stripQuotes(trimmed);
};

/**
 * Collects block-style `- item` array values that follow a frontmatter key.
 */
const collectBlockArrayValues = (
  lines: string[],
  startIndex: number,
): { nextIndex: number; values: string[] } => {
  const values: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }

    if (!trimmed.startsWith("- ")) {
      break;
    }

    const value = stripQuotes(trimmed.slice(2).trim());

    if (value.length > 0) {
      values.push(value);
    }

    index += 1;
  }

  return {
    nextIndex: index,
    values,
  };
};

/**
 * Parses a YAML-like frontmatter block into a flat attribute map.
 */
const parseFrontmatterAttributes = (
  frontmatterBlock: string,
): Record<string, FrontmatterValue> => {
  const attributes: Record<string, FrontmatterValue> = {};
  const lines = frontmatterBlock.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1);

    if (!normalizeOptionalString(rawValue)) {
      const { nextIndex, values } = collectBlockArrayValues(lines, index + 1);

      if (values.length > 0) {
        attributes[key] = values;
        index = nextIndex - 1;
        continue;
      }
    }

    attributes[key] = parseScalarValue(rawValue);
  }

  return attributes;
};

/**
 * Parses a Markdown document with optional YAML-like frontmatter into
 * structured attributes and a trimmed body.
 */
export const parseMarkdownDocument = (
  content: string,
): ParsedMarkdownDocument => {
  const match = content.match(FRONTMATTER_PATTERN);

  if (!match) {
    return {
      attributes: {},
      body: content.trim(),
    };
  }

  const frontmatterBlock = match[1];

  if (frontmatterBlock === undefined) {
    return {
      attributes: {},
      body: content.trim(),
    };
  }

  const body = content.slice(match[0].length).trim();

  return {
    attributes: parseFrontmatterAttributes(frontmatterBlock),
    body,
  };
};
