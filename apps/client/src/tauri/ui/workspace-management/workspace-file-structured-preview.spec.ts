import { describe, expect, it } from "vitest";
import {
  csvDelimiter,
  flattenJsonTree,
  parseCsv,
  parseJsonPreview,
  structuredPreviewKind,
} from "./workspace-file-structured-preview";

describe("structured file previews", () => {
  it("detects CSV and JSON files", () => {
    expect(structuredPreviewKind("data.CSV")).toBe("csv");
    expect(structuredPreviewKind("table.tsv")).toBe("csv");
    expect(structuredPreviewKind("tsconfig.json")).toBe("json");
    expect(structuredPreviewKind("readme.md")).toBeNull();
  });

  it("parses quoted CSV fields, CRLF rows and semicolon delimiters", () => {
    const text = '﻿name;note\r\n"Doe; Jane";"said ""hi""\nthere"\r\nBob\r\n';
    expect(csvDelimiter("data.csv", text)).toBe(";");
    expect(parseCsv(text, ";")).toEqual({
      header: ["name", "note"],
      rows: [
        ["Doe; Jane", 'said "hi"\nthere'],
        ["Bob", ""],
      ],
      truncated: false,
    });
  });

  it("limits large CSV files", () => {
    const text = [
      "a,b",
      ...Array.from({ length: 20 }, (_, index) => `${index},x`),
    ].join("\n");
    const table = parseCsv(text, ",", 5);
    expect(table.rows).toHaveLength(5);
    expect(table.truncated).toBe(true);
  });

  it("reads JSON with comments and trailing commas and flattens expanded nodes", () => {
    const parsed = parseJsonPreview(
      '{\n// note\n"a": {"b": [1, 2,],},\n"c/d": null, /* x */ "e": "text"}',
    );
    expect("value" in parsed).toBe(true);
    if (!("value" in parsed)) return;
    const collapsed = flattenJsonTree(parsed.value, new Set([""]));
    expect(collapsed.nodes.map((node) => [node.key, node.summary])).toEqual([
      ["", "{3}"],
      ["a", "{1}"],
      ["c/d", "null"],
      ["e", '"text"'],
    ]);
    const expanded = flattenJsonTree(parsed.value, new Set(["", "/a", "/a/b"]));
    expect(expanded.nodes.map((node) => node.path)).toEqual([
      "",
      "/a",
      "/a/b",
      "/a/b/0",
      "/a/b/1",
      "/c~1d",
      "/e",
    ]);
    expect(parseJsonPreview("{")).toHaveProperty("error");
  });
});
