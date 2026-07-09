import {
  getFilePreviewRenderKind,
  resolveFilePreviewSyntax,
} from "./file-preview-language";

describe("file preview language resolution", () => {
  it.each([
    ["Dockerfile", "dockerfile", "Dockerfile"],
    ["Dockerfile.dev", "dockerfile", "Dockerfile"],
    ["Containerfile", "dockerfile", "Dockerfile"],
    ["Makefile", "makefile", "Makefile"],
    ["Makefile.am", "makefile", "Makefile"],
    ["AGENTS", "markdown", "Markdown"],
    ["README", "markdown", "Markdown"],
    [".env.local", "properties", "Properties"],
  ])(
    "maps exact or pattern file name %s without requiring an extension",
    (fileName, language, label) => {
      expect(resolveFilePreviewSyntax(fileName)).toEqual({
        language,
        label,
      });
    },
  );

  it.each([
    ["src/main.ts", "typescript", "TypeScript"],
    ["src/widget.tsx", "typescript", "TypeScript"],
    ["src/index.js", "javascript", "JavaScript"],
    ["include/widget.hpp", "cpp", "C++"],
    ["data/config.yaml", "yaml", "YAML"],
  ])("maps %s by extension", (fileName, language, label) => {
    expect(resolveFilePreviewSyntax(fileName)).toEqual({
      language,
      label,
    });
  });

  it.each(["notes.txt", "table.csv", "unknown.custom"])(
    "falls back to plain text for %s",
    (fileName) => {
      expect(resolveFilePreviewSyntax(fileName)).toEqual({
        language: null,
        label: "Plain text",
      });
    },
  );

  it.each([
    ["screenshot.png", "image"],
    ["manual.pdf", "pdf"],
    ["src/main.cpp", "text"],
  ])("resolves render mode for %s", (fileName, mode) => {
    expect(getFilePreviewRenderKind(fileName)).toBe(mode);
  });
});
