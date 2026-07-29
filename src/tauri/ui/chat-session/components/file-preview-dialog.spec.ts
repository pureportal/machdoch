import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FilePreviewStatus,
  FilePreviewTextContent,
  FilePreviewVisualContent,
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

  it("offers text and visual modes for Markdown and HTML files", () => {
    for (const preview of [
      createPreview({
        title: "README.md",
        path: "README.md",
        language: "markdown",
      }),
      createPreview({
        title: "index.html",
        path: "public/index.html",
        language: "xml",
      }),
    ]) {
      const markup = renderToStaticMarkup(
        createElement(FilePreviewTextContent, { preview }),
      );

      expect(markup).toContain('role="group" aria-label="File preview mode"');
      expect(markup).toContain(
        'aria-pressed="true" aria-label="Show text preview"',
      );
      expect(markup).toContain(
        'aria-pressed="false" aria-label="Show visual preview"',
      );
      expect(markup).toContain('aria-label="Syntax highlighting"');
      expect(markup).toContain('aria-label="Find in file"');
    }
  });

  it("keeps ordinary text files in the existing text-only preview", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePreviewTextContent, {
        preview: createPreview({
          title: "notes.txt",
          path: "docs/notes.txt",
          language: null,
        }),
      }),
    );

    expect(markup).not.toContain('aria-label="File preview mode"');
    expect(markup).toContain('aria-label="Syntax highlighting"');
    expect(markup).toContain('aria-label="Find in file"');
    expect(markup).toContain('aria-label="Contents of notes.txt"');
  });
});

describe("FilePreviewStatus", () => {
  it("hides the line hint when a file opens at line 1", () => {
    for (const content of ["only line", "line one\nline two\nline three"]) {
      const markup = renderToStaticMarkup(
        createElement(FilePreviewStatus, {
          preview: createPreview({ content, targetLine: 1 }),
        }),
      );

      expect(markup).not.toContain("Opened at line");
    }
  });

  it("shows the requested line hint when a multi-line file opens after line 1", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePreviewStatus, {
        preview: createPreview({
          content: "line one\nline two\n",
          targetLine: 2,
        }),
      }),
    );

    expect(markup).toContain("Opened at line 2");
  });
});

describe("FilePreviewVisualContent", () => {
  it("renders Markdown content without changing the source string", () => {
    const content = "# Heading\n\nA **formatted** value.";
    const markup = renderToStaticMarkup(
      createElement(FilePreviewVisualContent, {
        preview: createPreview({
          title: "README.md",
          path: "README.md",
          content,
          language: "markdown",
        }),
        visualKind: "markdown",
      }),
    );

    expect(markup).toContain("<h1>Heading</h1>");
    expect(markup).toContain("<strong>formatted</strong>");
    expect(content).toBe("# Heading\n\nA **formatted** value.");
  });

  it("places unchanged HTML content in a script-disabled visual preview", () => {
    const content = "<main><h1>Heading</h1><p>Body</p></main>";
    const markup = renderToStaticMarkup(
      createElement(FilePreviewVisualContent, {
        preview: createPreview({
          title: "index.html",
          path: "public/index.html",
          content,
          language: "xml",
        }),
        visualKind: "html",
      }),
    );

    expect(markup).toContain('sandbox=""');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain(
      'srcDoc="&lt;main&gt;&lt;h1&gt;Heading&lt;/h1&gt;&lt;p&gt;Body&lt;/p&gt;&lt;/main&gt;"',
    );
    expect(content).toBe("<main><h1>Heading</h1><p>Body</p></main>");
  });
});
