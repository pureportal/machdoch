import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FilePreviewTextContent,
  type FilePreview,
} from "./file-preview-dialog.tsx";

const createPreview = (overrides: Partial<FilePreview> = {}): FilePreview => ({
  title: "branch.dto.ts",
  path: "src/branch.dto.ts",
  mode: "text",
  loading: false,
  error: null,
  source: null,
  content: "line one\nline two\nline three",
  language: "typescript",
  languageLabel: "TypeScript",
  truncated: false,
  lossy: false,
  targetLine: null,
  ...overrides,
});

describe("FilePreviewTextContent", () => {
  it("marks a requested source line so it can be identified and scrolled into view", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePreviewTextContent, {
        preview: createPreview({ targetLine: 2 }),
      }),
    );

    expect(markup).toContain('data-file-preview-target-line="2"');
    expect(markup).toContain('aria-current="location"');
    expect(markup).toContain('aria-label="Select line 2 (opened location)"');
  });

  it("does not mark a target when a file is opened without a line", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePreviewTextContent, {
        preview: createPreview(),
      }),
    );

    expect(markup).not.toContain("data-file-preview-target-line");
    expect(markup).not.toContain('aria-current="location"');
  });
});
