import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageMarkdown } from "./message-markdown.tsx";

const renderMarkdown = (content: string): string =>
  renderToStaticMarkup(createElement(MessageMarkdown, { content }));

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
});
