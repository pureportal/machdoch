export type StructuredPreviewKind = "csv" | "json";

export interface CsvTable {
  header: string[];
  rows: string[][];
  truncated: boolean;
}

export interface JsonTreeNode {
  path: string;
  key: string;
  depth: number;
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  summary: string;
  childCount: number;
}

const MAX_CSV_ROWS = 5_000;
const MAX_JSON_NODES = 20_000;

export const structuredPreviewKind = (
  fileName: string,
): StructuredPreviewKind | null => {
  const extension = fileName.toLowerCase().split(".").at(-1);
  if (extension === "csv" || extension === "tsv") return "csv";
  if (extension === "json" || extension === "jsonc" || extension === "geojson")
    return "json";
  return null;
};

export const csvDelimiter = (fileName: string, text: string): string => {
  if (fileName.toLowerCase().endsWith(".tsv")) return "\t";
  const firstLine = text.slice(0, text.search(/\r?\n|$/u));
  const counts = [",", ";", "\t", "|"].map((delimiter) => ({
    delimiter,
    count: firstLine.split(delimiter).length,
  }));
  return counts.sort((left, right) => right.count - left.count)[0]!.delimiter;
};

export const parseCsv = (
  text: string,
  delimiter: string,
  maxRows = MAX_CSV_ROWS,
): CsvTable => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const pushRow = (): boolean => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    if (rows.length > maxRows) {
      truncated = true;
      return false;
    }
    return true;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      if (!pushRow()) break;
    } else field += character;
  }
  if (!truncated && (field !== "" || row.length > 0)) pushRow();
  const [header = [], ...body] = rows.slice(0, maxRows + 1);
  const width = Math.max(header.length, ...body.map((entry) => entry.length));
  const pad = (entry: string[]): string[] =>
    entry.length >= width
      ? entry
      : [...entry, ...Array<string>(width - entry.length).fill("")];
  return {
    header: pad(header),
    rows: body.slice(0, maxRows).map(pad),
    truncated,
  };
};

const stripJsonComments = (text: string): string => {
  let output = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      output += character;
      if (character === "\\") {
        output += text[index + 1] ?? "";
        index += 1;
      } else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
    } else if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else output += character;
  }
  return output.replace(/,(\s*[}\]])/gu, "$1");
};

export const parseJsonPreview = (
  text: string,
): { value: unknown } | { error: string } => {
  try {
    return { value: JSON.parse(stripJsonComments(text)) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const nodeKind = (value: unknown): JsonTreeNode["kind"] =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : (typeof value as JsonTreeNode["kind"]);

const nodeSummary = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).length}}`;
  if (typeof value === "string")
    return JSON.stringify(
      value.length > 200 ? `${value.slice(0, 200)}…` : value,
    );
  return String(value);
};

export const flattenJsonTree = (
  value: unknown,
  expanded: ReadonlySet<string>,
  maxNodes = MAX_JSON_NODES,
): { nodes: JsonTreeNode[]; truncated: boolean } => {
  const nodes: JsonTreeNode[] = [];
  const visit = (
    current: unknown,
    key: string,
    path: string,
    depth: number,
  ): boolean => {
    if (nodes.length >= maxNodes) return false;
    const children =
      current && typeof current === "object"
        ? Object.entries(current as Record<string, unknown>)
        : [];
    nodes.push({
      path,
      key,
      depth,
      kind: nodeKind(current),
      summary: nodeSummary(current),
      childCount: children.length,
    });
    if (!expanded.has(path)) return true;
    for (const [childKey, child] of children)
      if (
        !visit(
          child,
          childKey,
          `${path}/${childKey.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
          depth + 1,
        )
      )
        return false;
    return true;
  };
  const complete = visit(value, "", "", 0);
  return { nodes, truncated: !complete };
};
