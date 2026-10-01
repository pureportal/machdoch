import { describe, expect, it } from "vitest";
import { getFilePreviewRenderKind } from "./file-preview-language";

describe("file preview support", () => {
  it.each([
    ["C:\\Temp\\Logo.PNG", "image"],
    ["/tmp/report.PDF", "pdf"],
    ["src/main.ts", "text"],
    ["design/logo.svg", "text"],
    ["preview/index.html", "text"],
    ["README.md", "text"],
    ["Dockerfile.production", "text"],
    [".env.local", "text"],
    ["notes.txt", "text"],
    ["results.csv", "text"],
    ["LICENSE", "text"],
  ])("previews %s as %s", (path, kind) => {
    expect(getFilePreviewRenderKind(path)).toBe(kind);
  });

  it.each([
    "archive.zip",
    "model.safetensors",
    "document.docx",
    "app.exe",
    "movie.mp4",
    "data.unknown",
  ])("opens %s externally", (path) => {
    expect(getFilePreviewRenderKind(path)).toBeNull();
  });
});
