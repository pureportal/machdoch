import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageMarkdown } from "./message-markdown.tsx";

const renderMarkdown = (
  content: string,
  props: Omit<ComponentProps<typeof MessageMarkdown>, "content"> = {},
): string =>
  renderToStaticMarkup(createElement(MessageMarkdown, { content, ...props }));

describe("MessageMarkdown", () => {
  it("renders GFM tables with semantic sections, rows, and cells", () => {
    const markup = renderMarkdown(`
| Identifier | Meaning | Mapping/use |
| :--- | :--- | ---: |
| \`vehicle.v1Id\` | ID of the vehicle record in V1 | Absent in this flow; never populated from the branch |
| Selected company's V1 ID | V1 identifier of \`selectedBranch.company\` | \`f1firma\`; also determines \`dms\` |
| Selected branch UUID | Cloud branch identifier with content that can wrap in a narrow message | Saved as \`vehicle.owningBranch\` |
`);

    expect(markup).toContain(
      '<div role="region" aria-label="Markdown table" tabindex="0" class="app-message-table-scroll">',
    );
    expect(markup).toContain('<table class="app-message-table">');
    expect(markup).toContain("<thead><tr>");
    expect(markup).toContain('<th style="text-align:left">Identifier</th>');
    expect(markup).toContain('<th style="text-align:right">Mapping/use</th>');
    expect(markup).toContain("<tbody><tr>");
    expect(markup).toMatch(/<td[^>]*><code/);
    expect(markup).toContain("vehicle.v1Id</code></td>");
    expect(markup.match(/<tr>/g)).toHaveLength(4);
    expect(markup.match(/<th(?:\s|>)/g)).toHaveLength(3);
    expect(markup.match(/<td(?:\s|>)/g)).toHaveLength(9);
  });

  it("does not turn table-like text without a delimiter row into a table", () => {
    const markup = renderMarkdown("Identifier | Meaning | Mapping/use");

    expect(markup).not.toContain("<table");
    expect(markup).toContain("<p");
  });

  it("renders a Windows Markdown path with a trailing line as a workspace file button", () => {
    const markup = renderMarkdown(
      "[get-branch-label.ts](C:/Development/alpartis.morgana/app.alpartis.cloud/src/common/helpers/get-branch-label.ts:13)",
      {
        workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
        onOpenWorkspaceFile: () => undefined,
      },
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain(
      'data-workspace-path="src/common/helpers/get-branch-label.ts"',
    );
    expect(markup).toContain('data-workspace-line="13"');
    expect(markup).toContain(">get-branch-label.ts</button>");
  });

  it("auto-links a bare Windows path inside the active workspace", () => {
    const markup = renderMarkdown(
      "Location: C:/Development/alpartis.morgana/app.alpartis.cloud/src/branch.dto.ts:27.",
      {
        workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
        onOpenWorkspaceFile: () => undefined,
      },
    );

    expect(markup).toContain(
      'data-workspace-path="src/branch.dto.ts" data-workspace-line="27"',
    );
    expect(markup).toContain(
      ">C:/Development/alpartis.morgana/app.alpartis.cloud/src/branch.dto.ts:27</button>.",
    );
  });

  it("keeps workspace paths without a line clickable without adding a line target", () => {
    const markup = renderMarkdown(
      "[branch.dto.ts](C:/Development/alpartis.morgana/app.alpartis.cloud/src/branch.dto.ts)",
      {
        workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
        onOpenWorkspaceFile: () => undefined,
      },
    );

    expect(markup).toContain('data-workspace-path="src/branch.dto.ts"');
    expect(markup).not.toContain("data-workspace-line");
  });

  it("does not auto-link unsupported paths or change normal prose", () => {
    const markup = renderMarkdown(
      "Normal prose and C:/Other/secret.ts:1 stay unchanged.",
      {
        workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
        onOpenWorkspaceFile: () => undefined,
      },
    );

    expect(markup).not.toContain("<button");
    expect(markup).toContain(
      '<p class="m-0 whitespace-pre-wrap wrap-break-word">Normal prose and C:/Other/secret.ts:1 stay unchanged.</p>',
    );
  });
});
