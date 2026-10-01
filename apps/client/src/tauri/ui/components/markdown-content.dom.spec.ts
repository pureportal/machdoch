/** @vitest-environment jsdom */

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./markdown-content";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

const renderedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"><text>Rendered diagram</text></svg>`;

beforeEach(() => {
  document.documentElement.dataset.theme = "dark";
  mermaidMocks.initialize.mockReset();
  mermaidMocks.parse.mockReset().mockResolvedValue({
    config: {},
    diagramType: "flowchart-v2",
  });
  mermaidMocks.render.mockReset().mockResolvedValue({ svg: renderedSvg });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("MarkdownContent code copying", () => {
  it("copies decoded fenced-code text without the parser-added trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      createElement(MarkdownContent, {
        content: `\`\`\`ts title="sample"
const value = "<tag> & text";
\`\`\``,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy code block to clipboard" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const value = "<tag> & text";');
    });
    expect(
      await screen.findByRole("button", { name: "Copied code block" }),
    ).toBeTruthy();
  });
});

describe("MarkdownContent file links", () => {
  const previewPath =
    "C:/Users/ehrha/AppData/Local/Temp/machdoch-goal-ui-review/final-composer-desktop.png";

  it("opens the reported preview link outside the workspace only after clicking", () => {
    const onOpenLocalFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    render(
      createElement(MarkdownContent, {
        content: `[View preview](${previewPath})`,
        workspaceRoot: "C:\\Development\\machdoch",
        onOpenWorkspaceFile,
        onOpenLocalFile,
      }),
    );

    expect(onOpenLocalFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View preview" }));
    expect(onOpenLocalFile).toHaveBeenCalledWith(previewPath, undefined);
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps workspace files using the workspace preview action", () => {
    const onOpenLocalFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    render(
      createElement(MarkdownContent, {
        content: "[Source](C:/Development/machdoch/src/main.ts:17)",
        workspaceRoot: "C:\\Development\\machdoch",
        onOpenWorkspaceFile,
        onOpenLocalFile,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith("src/main.ts", 17);
    expect(onOpenLocalFile).not.toHaveBeenCalled();
  });

  it("decodes spaces and source locations from local file URLs", () => {
    const onOpenLocalFile = vi.fn();
    render(
      createElement(MarkdownContent, {
        content: "[Report](file:///C:/Temp/My%20report.md#L12)",
        onOpenLocalFile,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(onOpenLocalFile).toHaveBeenCalledWith("C:/Temp/My report.md", 12);
  });

  it("uses the latest local file action without remounting selected text", () => {
    const firstOpen = vi.fn();
    const latestOpen = vi.fn();
    const props = { content: `Result: [View preview](${previewPath})` };
    const { container, rerender } = render(
      createElement(MarkdownContent, { ...props, onOpenLocalFile: firstOpen }),
    );
    const text = container.querySelector("p")?.firstChild;
    rerender(
      createElement(MarkdownContent, { ...props, onOpenLocalFile: latestOpen }),
    );
    expect(container.querySelector("p")?.firstChild).toBe(text);
    fireEvent.click(screen.getByRole("button", { name: "View preview" }));
    expect(firstOpen).not.toHaveBeenCalled();
    expect(latestOpen).toHaveBeenCalledWith(previewPath, undefined);
  });

  it("keeps unsafe protocols and local image embeds blocked", () => {
    const onOpenLocalFile = vi.fn();
    const { container } = render(
      createElement(MarkdownContent, {
        content:
          "[Unsafe](javascript:alert%281%29)\n\n![Hidden](file:///C:/Temp/image.png)\n\n[Site](https://example.com)\n\n[Section](#section)",
        onOpenLocalFile,
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Site" }).getAttribute("href"),
    ).toBe("https://example.com");
    expect(
      screen.getByRole("link", { name: "Section" }).getAttribute("target"),
    ).toBeNull();
    expect(onOpenLocalFile).not.toHaveBeenCalled();
  });
});

describe("MarkdownContent Mermaid diagrams", () => {
  it("renders a valid Mermaid fence as an isolated SVG image", async () => {
    const { container } = render(
      createElement(MarkdownContent, {
        content: `Before

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

After`,
      }),
    );

    const diagram = await screen.findByRole("region", {
      name: "Mermaid diagram",
    });
    const image = diagram.querySelector("img");

    expect(image?.src).toContain("data:image/svg+xml;charset=utf-8,");
    expect(decodeURIComponent(image?.src.split(",")[1] ?? "")).toContain(
      "Rendered diagram",
    );
    expect(image?.style.width).toBe("640px");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(mermaidMocks.parse).toHaveBeenCalledWith("flowchart LR\n  A --> B", {
      suppressErrors: true,
    });
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/u),
      "flowchart LR\n  A --> B",
    );
    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        darkMode: true,
        htmlLabels: false,
        secure: expect.arrayContaining([
          "securityLevel",
          "theme",
          "themeCSS",
          "htmlLabels",
        ]),
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "dark",
      }),
    );
  });

  it("never inserts generated SVG markup into the message DOM", async () => {
    mermaidMocks.render.mockResolvedValue({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><script>globalThis.compromised = true</script><text>Safe image context</text></svg>`,
    });
    const { container } = render(
      createElement(MarkdownContent, {
        content: `\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``,
      }),
    );

    const diagram = await screen.findByRole("region", {
      name: "Mermaid diagram",
    });
    const imageSource = diagram.querySelector("img")?.src ?? "";

    expect(decodeURIComponent(imageSource.split(",")[1] ?? "")).toContain(
      "<script>",
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps invalid Mermaid source readable without disturbing surrounding Markdown", async () => {
    mermaidMocks.parse.mockResolvedValue(false);

    render(
      createElement(MarkdownContent, {
        content: `Before

\`\`\`mermaid
flowchart LR
  A --
\`\`\`

After`,
      }),
    );

    expect(
      await screen.findByText(
        "Diagram could not be rendered. Check its Mermaid syntax.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("After")).toBeTruthy();
    expect(screen.getByText(/flowchart LR/u)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Copy code block to clipboard",
      }),
    ).toBeTruthy();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("does not invoke Mermaid for an ordinary fenced code block", () => {
    render(
      createElement(MarkdownContent, {
        content: `\`\`\`ts
const ready = true;
\`\`\``,
      }),
    );

    expect(
      screen.getByRole("button", {
        name: "Copy code block to clipboard",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Mermaid diagram" }),
    ).toBeNull();
    expect(mermaidMocks.initialize).not.toHaveBeenCalled();
    expect(mermaidMocks.parse).not.toHaveBeenCalled();
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });

  it("renders only the latest source when a Mermaid fence changes during streaming", async () => {
    const { rerender } = render(
      createElement(MarkdownContent, {
        content: `Response

\`\`\`mermaid
flowchart LR
  A --`,
      }),
    );

    rerender(
      createElement(MarkdownContent, {
        content: `Response

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

Complete`,
      }),
    );

    expect(
      await screen.findByRole("region", { name: "Mermaid diagram" }),
    ).toBeTruthy();
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(mermaidMocks.parse).toHaveBeenCalledTimes(1);
    expect(mermaidMocks.parse).toHaveBeenCalledWith("flowchart LR\n  A --> B", {
      suppressErrors: true,
    });
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
  });

  it("rerenders diagrams when the application theme changes", async () => {
    render(
      createElement(MarkdownContent, {
        content: `\`\`\`mermaid
sequenceDiagram
  A->>B: Hello
\`\`\``,
      }),
    );

    await screen.findByRole("region", { name: "Mermaid diagram" });
    document.documentElement.dataset.theme = "light";

    await waitFor(() => {
      expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          darkMode: false,
          theme: "default",
        }),
      );
      expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
    });
  });
});
