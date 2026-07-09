import { cleanup, render, screen, within } from "@testing-library/react";
import { FilePreviewDialog, type FilePreview } from "./file-preview-dialog";

afterEach(() => {
  cleanup();
});

const createPreview = (overrides: Partial<FilePreview> = {}): FilePreview => ({
  title: "main.ts",
  path: "src/main.ts",
  mode: "text",
  loading: false,
  error: null,
  source: null,
  content: "const value = 1;",
  language: "typescript",
  languageLabel: "TypeScript",
  truncated: false,
  lossy: false,
  ...overrides,
});

describe("FilePreviewDialog", () => {
  it("renders syntax-highlighted code for supported languages", () => {
    render(
      <FilePreviewDialog
        preview={createPreview()}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    expect(screen.getByText("TypeScript")).toBeDefined();
    expect(screen.getByLabelText("Contents of main.ts").textContent).toContain(
      "const value = 1;",
    );
    expect(document.body.querySelector(".hljs-keyword")?.textContent).toBe(
      "const",
    );
  });

  it("renders unknown file content as escaped text", () => {
    const { container } = render(
      <FilePreviewDialog
        preview={createPreview({
          title: "payload.txt",
          path: "payload.txt",
          content: "<script>window.machdochUnsafe = true</script>",
          language: null,
          languageLabel: "Plain text",
        })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const codeBlock = screen.getByLabelText("Contents of payload.txt");

    expect(within(codeBlock).getByText(/window\.machdochUnsafe/u)).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
  });
});
