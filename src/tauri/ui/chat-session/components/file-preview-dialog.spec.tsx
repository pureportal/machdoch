import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FilePreviewDialog, type FilePreview } from "./file-preview-dialog";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
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

  it("keeps and copies a direct text selection after pointer release", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <FilePreviewDialog
        preview={createPreview({
          content: "alpha beta",
          language: null,
          languageLabel: "Plain text",
        })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const previewContents = screen.getByLabelText("Contents of main.ts");
    const code = previewContents.querySelector("code");
    const textNode = code?.firstChild;

    expect(textNode).toBeInstanceOf(Text);

    const range = document.createRange();

    fireEvent.pointerDown(previewContents, { button: 0, pointerId: 1 });
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    expect(
      screen.queryByRole("button", { name: "Copy selected text" }),
    ).toBeNull();

    fireEvent.pointerUp(document, { pointerId: 1 });

    const copyButton = await screen.findByRole("button", {
      name: "Copy selected text",
    });

    expect(window.getSelection()?.toString()).toBe("alpha");

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("alpha");
      expect(
        screen.getByRole("button", { name: "Selected text copied" }),
      ).toBeDefined();
    });
  });

  it("positions copy at the focus endpoint of a backward text selection", async () => {
    const originalGetClientRects = Range.prototype.getClientRects;

    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value(this: Range): DOMRect[] {
        if (this.collapsed && this.startOffset === 0) {
          return [
            {
              bottom: 120,
              height: 20,
              left: 80,
              right: 80,
              top: 100,
              width: 0,
              x: 80,
              y: 100,
              toJSON: () => ({}),
            },
          ];
        }

        return [
          {
            bottom: 220,
            height: 20,
            left: 220,
            right: 240,
            top: 200,
            width: 20,
            x: 220,
            y: 200,
            toJSON: () => ({}),
          },
        ];
      },
    });

    try {
      render(
        <FilePreviewDialog
          preview={createPreview({
            content: "alpha beta",
            language: null,
            languageLabel: "Plain text",
          })}
          onOpenChange={vi.fn()}
          onOpenExternal={vi.fn()}
        />,
      );

      const previewContents = screen.getByLabelText("Contents of main.ts");
      const code = previewContents.querySelector("code");
      const textNode = code?.firstChild;
      const codeSurface = previewContents.parentElement;

      expect(textNode).toBeInstanceOf(Text);
      expect(codeSurface).not.toBeNull();

      vi.spyOn(codeSurface!, "getBoundingClientRect").mockReturnValue({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      fireEvent.pointerDown(previewContents, { button: 0, pointerId: 2 });
      window.getSelection()?.setBaseAndExtent(textNode!, 10, textNode!, 0);
      fireEvent(document, new Event("selectionchange"));
      fireEvent.pointerUp(document, { pointerId: 2 });

      const copyButton = await screen.findByRole("button", {
        name: "Copy selected text",
      });

      expect(copyButton.style.left).toBe("88px");
      expect(copyButton.style.top).toBe("68px");
    } finally {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: originalGetClientRects,
      });
    }
  });

  it("selects and copies complete lines from the gutter", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <FilePreviewDialog
        preview={createPreview({ content: "first\nsecond\nthird" })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select line 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Select line 3" }), {
      shiftKey: true,
    });

    expect(
      screen.getByRole("button", { name: "Select line 2" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("first\nsecond\nthird"),
    );
  });

  it("selects every complete line crossed while dragging gutter dots", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <FilePreviewDialog
        preview={createPreview({
          content: "first\nsecond\nthird\nfourth",
        })}
        onOpenChange={vi.fn()}
        onOpenExternal={vi.fn()}
      />,
    );

    const gutter = screen.getByRole("group", {
      name: "Select complete lines",
    });

    vi.spyOn(gutter, "getBoundingClientRect").mockReturnValue({
      bottom: 96,
      height: 96,
      left: 0,
      right: 40,
      top: 0,
      width: 40,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Select line 2" }),
      { button: 0, clientY: 46, pointerId: 7 },
    );
    fireEvent.pointerMove(gutter, { clientY: 86, pointerId: 7 });
    fireEvent.pointerUp(gutter, { clientY: 86, pointerId: 7 });

    expect(
      screen.getByRole("button", { name: "Select line 4" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    expect(
      screen.getByRole("button", { name: "Copy selected text" }).style.top,
    ).toBe("44px");

    fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("second\nthird\nfourth"),
    );
  });
});
