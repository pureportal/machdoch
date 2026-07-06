import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MessageMarkdown } from "./message-markdown";

afterEach(() => {
  cleanup();
});

describe("MessageMarkdown", () => {
  it("keeps web links as normal anchors", () => {
    render(<MessageMarkdown content="[Docs](https://example.com/docs)" />);

    const link = screen.getByRole("link", { name: "Docs" });

    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("opens Windows absolute workspace links through the workspace file handler", () => {
    const onOpenWorkspaceFile = vi.fn();

    render(
      <MessageMarkdown
        content={[
          "Changed:",
          "- [task-thinking-panel.tsx](C:/Development/machdoch/src/tauri/ui/task-thinking-panel.tsx:250)",
        ].join("\n")}
        workspaceRoot="C:\\Development\\machdoch"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "task-thinking-panel.tsx" }),
    );

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      "src/tauri/ui/task-thinking-panel.tsx",
    );
    expect(
      screen.queryByRole("link", { name: "task-thinking-panel.tsx" }),
    ).toBeNull();
  });

  it("opens encoded file URLs inside the workspace", () => {
    const onOpenWorkspaceFile = vi.fn();

    render(
      <MessageMarkdown
        content="[report](<file:///C:/Development/machdoch/docs/My%20Report.md#L12>)"
        workspaceRoot="C:/Development/machdoch"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "report" }));

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith("docs/My Report.md");
  });

  it("opens relative workspace source links without navigating to the app origin", () => {
    const onOpenWorkspaceFile = vi.fn();

    render(
      <MessageMarkdown
        content="[spec](src/tauri/ui/task-thinking-panel.spec.tsx:44)"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "spec" }));

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(
      "src/tauri/ui/task-thinking-panel.spec.tsx",
    );
  });

  it("opens extensionless workspace file links through the workspace handler", () => {
    const onOpenWorkspaceFile = vi.fn();

    render(
      <MessageMarkdown
        content="[Dockerfile](Dockerfile:12)"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dockerfile" }));

    expect(onOpenWorkspaceFile).toHaveBeenCalledWith("Dockerfile");
  });

  it("renders local paths outside the active workspace inertly", () => {
    const onOpenWorkspaceFile = vi.fn();

    render(
      <MessageMarkdown
        content="[secret](C:/Other/secret.ts:1)"
        workspaceRoot="C:/Development/machdoch"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />,
    );

    expect(screen.getByText("secret")).toBeDefined();
    expect(screen.queryByRole("button", { name: "secret" })).toBeNull();
    expect(screen.queryByRole("link", { name: "secret" })).toBeNull();

    fireEvent.click(screen.getByText("secret"));

    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("does not render unsafe hrefs as clickable links", () => {
    render(<MessageMarkdown content="[bad](javascript:alert(1))" />);

    expect(screen.getByText("bad")).toBeDefined();
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  });

  it("marks structured findings paragraphs for compact field spacing", () => {
    const { container } = render(
      <MessageMarkdown
        content={[
          "**Findings**",
          "",
          "Severity: Critical",
          "",
          "Location: `Migration20260703115310.ts`",
          "",
          "Issue: Existing model data is dropped.",
          "",
          "Evidence: The migration drops `vehicle_model_uuid_foreign`.",
          "",
          "Impact: Vehicle rows would point at missing model generations.",
          "",
          "Recommendation: Preserve the old model UUIDs.",
          "",
          "Severity: Low",
          "",
          "Location: `app.alphartis.cloud` PR #814 / Codecov thread",
        ].join("\n")}
      />,
    );

    const paragraphs = Array.from(
      container.querySelectorAll<HTMLParagraphElement>(
        ".app-message-markdown > p",
      ),
    );

    expect(paragraphs.map((paragraph) => paragraph.dataset.mdField)).toEqual([
      undefined,
      "severity",
      "location",
      "issue",
      "evidence",
      "impact",
      "recommendation",
      "severity",
      "location",
    ]);
  });

  it("copies fenced code block content from the icon button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MessageMarkdown content={"```ts\nconst value = 1;\nconsole.log(value);\n```"} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy code block to clipboard",
      }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "const value = 1;\nconsole.log(value);",
      );
    });

    expect(
      screen.getByRole("button", { name: "Copied code block" }),
    ).toBeDefined();
  });
});
