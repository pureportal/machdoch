import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

    expect(
      (screen.getByLabelText("Syntax highlighting") as HTMLSelectElement)
        .value,
    ).toBe("typescript");
    expect(screen.getByLabelText("Contents of main.ts").textContent).toContain(
      "const value = 1;",
    );
    expect(document.body.querySelector(".hljs-keyword")?.textContent).toBe(
      "const",
    );
  });

  it("allows changing the syntax highlighting language", () => {
    render(
      <FilePreviewDialog
        preview={createPreview()}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );
    const syntaxSelector = screen.getByLabelText("Syntax highlighting");

    fireEvent.change(syntaxSelector, { target: { value: "plaintext" } });

    expect(document.body.querySelector(".hljs-keyword")).toBeNull();

    fireEvent.change(syntaxSelector, { target: { value: "javascript" } });

    expect(document.body.querySelector(".hljs-keyword")?.textContent).toBe(
      "const",
    );
  });

  it("finds and navigates all plain text matches", () => {
    render(
      <FilePreviewDialog
        preview={createPreview({ content: "value VALUE other value" })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in file" }), {
      target: { value: "value" },
    });

    expect(
      document.body.querySelectorAll(".app-file-preview-match"),
    ).toHaveLength(3);
    expect(screen.getByText("1 of 3")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));

    expect(screen.getByText("2 of 3")).toBeDefined();
    expect(
      document.body.querySelector('[data-file-preview-match="active"]')
        ?.textContent,
    ).toBe("VALUE");
  });

  it("supports regular expression search and reports invalid patterns", () => {
    render(
      <FilePreviewDialog
        preview={createPreview({ content: "item-1 item-22 item-x" })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );
    const searchInput = screen.getByRole("searchbox", {
      name: "Find in file",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Use regular expression search" }),
    );
    fireEvent.change(searchInput, { target: { value: "item-\\d+" } });

    const matchIndexes = new Set(
      Array.from(
        document.body.querySelectorAll(".app-file-preview-match"),
        (match) => match.getAttribute("data-match-index"),
      ),
    );

    expect([...matchIndexes]).toEqual(["0", "1"]);
    expect(screen.getByText("1 of 2")).toBeDefined();

    fireEvent.change(searchInput, { target: { value: "[" } });

    expect(screen.getByText("Invalid regex")).toBeDefined();
    expect(searchInput.getAttribute("aria-invalid")).toBe("true");
  });

  it("renders unknown file content as escaped text", () => {
    render(
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
    expect(document.body.querySelector("script")).toBeNull();
  });
});
