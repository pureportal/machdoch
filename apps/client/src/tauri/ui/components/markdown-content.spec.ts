import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./markdown-content.tsx";

const renderMarkdown = (
  content: string,
  props: Omit<ComponentProps<typeof MarkdownContent>, "content"> = {},
): string =>
  renderToStaticMarkup(createElement(MarkdownContent, { content, ...props }));

describe("MarkdownContent", () => {
  it("renders representative document structure inside the shared style scope", () => {
    const markup = renderMarkdown(`# Title

Introduction with **strong text** and ~~removed text~~.

## Section

- First item
- Second item

1. First step
2. Second step

> Quoted guidance

### Detail

---

\`inline code\`
`);

    expect(markup).toContain('class="app-markdown ');
    expect(markup).toContain("<h1>Title</h1>");
    expect(markup).toContain("<h2>Section</h2>");
    expect(markup).toContain("<h3>Detail</h3>");
    expect(markup).toContain("<strong>strong text</strong>");
    expect(markup).toContain("<del>removed text</del>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<ol>");
    expect(markup).toContain("<blockquote>");
    expect(markup).toContain("<hr/>");
    expect(markup).toContain('class="app-markdown-code"');
  });

  it("preserves GFM task lists and copyable fenced code blocks", () => {
    const markup = renderMarkdown(`- [x] Complete
- [ ] Pending

\`\`\`ts
const ready = true;
\`\`\`
`);

    expect(markup).toContain('class="contains-task-list"');
    expect(markup).toContain('class="task-list-item"');
    expect(markup).toContain('type="checkbox" disabled="" checked=""');
    expect(markup).toContain('class="app-markdown-code-block');
    expect(markup).toContain('class="app-markdown-code language-ts"');
    expect(markup).toContain('aria-label="Copy code block to clipboard"');
  });

  it("routes Mermaid fences through the diagram renderer without changing ordinary fences", () => {
    const mermaidMarkup = renderMarkdown(`Before

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

After
`);
    const ordinaryMarkup = renderMarkdown(`\`\`\`typescript
const diagram = "mermaid";
\`\`\``);

    expect(mermaidMarkup).toContain('class="app-mermaid-diagram"');
    expect(mermaidMarkup).toContain('data-mermaid-status="loading"');
    expect(mermaidMarkup).toContain(
      'class="app-markdown-code language-mermaid"',
    );
    expect(mermaidMarkup).toContain("Before");
    expect(mermaidMarkup).toContain("After");
    expect(ordinaryMarkup).not.toContain("app-mermaid-diagram");
    expect(ordinaryMarkup).toContain(
      'class="app-markdown-code language-typescript"',
    );
  });

  it("renders every heading level, Setext headings, and inline formatting in headings", () => {
    const markup = renderMarkdown(`# **Primary**

## *Secondary*

### Detail with \`code\`

#### Fourth

##### Fifth

###### Sixth

Setext **one**
===============

Setext *two*
------------
`);

    expect(markup).toContain("<h1><strong>Primary</strong></h1>");
    expect(markup).toContain("<h2><em>Secondary</em></h2>");
    expect(markup).toContain(
      '<h3>Detail with <code class="app-markdown-code">code</code></h3>',
    );
    expect(markup).toContain("<h4>Fourth</h4>");
    expect(markup).toContain("<h5>Fifth</h5>");
    expect(markup).toContain("<h6>Sixth</h6>");
    expect(markup).toContain("<h1>Setext <strong>one</strong></h1>");
    expect(markup).toContain("<h2>Setext <em>two</em></h2>");
  });

  it("distinguishes soft breaks, both hard-break forms, and paragraph boundaries", () => {
    const markup = renderMarkdown(
      "soft one\r\nsoft two  \r\nhard three\\\r\nhard four\r\n\r\nNext paragraph",
    ).replace(/\r\n?/gu, "\n");

    expect(markup).toContain(
      '<p class="app-markdown-paragraph">soft one\nsoft two<br/>\nhard three<br/>\nhard four</p>',
    );
    expect(markup).toContain(
      '<p class="app-markdown-paragraph">Next paragraph</p>',
    );
    expect(renderMarkdown(" \n\t\n")).not.toContain("<p");
  });

  it("renders ordered, unordered, nested, mixed, loose, and nested task lists", () => {
    const markup = renderMarkdown(`3. Third
4. Fourth
   - Nested bullet
     1. Nested number
        - [x] Nested task

- Loose item, first paragraph

  Loose item, second paragraph
`);

    expect(markup).toContain('<ol start="3">');
    expect(markup).toMatch(/<ul>\s*<li>Nested bullet/u);
    expect(markup).toMatch(/<ol>\s*<li>Nested number/u);
    expect(markup).toContain('class="contains-task-list"');
    expect(markup).toContain('class="task-list-item"');
    expect(markup).toContain(
      '<p class="app-markdown-paragraph">Loose item, first paragraph</p>',
    );
    expect(markup).toContain(
      '<p class="app-markdown-paragraph">Loose item, second paragraph</p>',
    );
  });

  it("keeps nested Markdown structure inside blockquotes", () => {
    const markup = renderMarkdown(`> ## Quoted **heading**
>
> 1. First
>    - Nested
>
> \`inline\`
>
> \`\`\`js
> const value = "<safe>";
> \`\`\`
`);

    expect(markup).toMatch(
      /<blockquote>\s*<h2>Quoted <strong>heading<\/strong><\/h2>/u,
    );
    expect(markup).toMatch(/<ol>\s*<li>First/u);
    expect(markup).toMatch(/<ul>\s*<li>Nested<\/li>\s*<\/ul>/u);
    expect(markup).toContain('class="app-markdown-code-block');
    expect(markup).toContain('class="app-markdown-code language-js"');
    expect(markup).toContain("&lt;safe&gt;");
  });

  it("preserves code text, useful language metadata, empty fences, and unclosed fences", () => {
    const markup = renderMarkdown(`Inline: \`a  & <tag>\`

~~~c++ title="example"
if (left < right && value > 0) {
  return "&value";
}
~~~

\`\`\`text
\`\`\`

\`\`\`sh
printf '%s' "$VALUE"
`);

    expect(markup).toContain(
      '<code class="app-markdown-code">a  &amp; &lt;tag&gt;</code>',
    );
    expect(markup).toContain('class="app-markdown-code language-c++"');
    expect(markup).toContain("left &lt; right &amp;&amp; value &gt; 0");
    expect(markup).toContain('class="app-markdown-code language-text"></code>');
    expect(markup).toContain('class="app-markdown-code language-sh"');
    expect(markup).toContain("$VALUE");
    expect(markup.match(/app-markdown-code-block/g)).toHaveLength(3);
  });

  it("renders GFM tables with semantic sections, rows, and cells", () => {
    const markup = renderMarkdown(`
| Identifier | Meaning | Mapping/use |
| :--- | :--- | ---: |
| \`vehicle.v1Id\` | ID of the vehicle record in V1 | Absent in this flow; never populated from the branch |
| Selected company's V1 ID | V1 identifier of \`selectedBranch.company\` | \`f1firma\`; also determines \`dms\` |
| Selected branch UUID | Cloud branch identifier with content that can wrap in a narrow message | Saved as \`vehicle.owningBranch\` |
`);

    expect(markup).toContain(
      '<div role="region" aria-label="Markdown table" tabindex="0" class="app-markdown-table-scroll">',
    );
    expect(markup).toContain('<table class="app-markdown-table">');
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

  it("keeps inline formatting and long unbroken content inside table cells", () => {
    const longCell = "segment".repeat(80);
    const markup = renderMarkdown(`| Left | Center | Right |
| :--- | :---: | ---: |
| **bold** | *emphasis* | \`${longCell}\` |
`);

    expect(markup).toContain('<th style="text-align:left">Left</th>');
    expect(markup).toContain('<th style="text-align:center">Center</th>');
    expect(markup).toContain('<th style="text-align:right">Right</th>');
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<em>emphasis</em>");
    expect(markup).toContain(longCell);
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

  it("opens workspace file fragments but keeps outside absolute paths inert", () => {
    const props = {
      workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
      onOpenWorkspaceFile: () => undefined,
    };
    const workspaceMarkup = renderMarkdown(
      "[Guide](docs/guide.md#usage)",
      props,
    );
    const outsideMarkup = renderMarkdown(
      "[Secret](C:/Other/secret.ts:1)",
      props,
    );

    expect(workspaceMarkup).toContain('data-workspace-path="docs/guide.md"');
    expect(outsideMarkup).not.toContain("<button");
    expect(outsideMarkup).not.toContain("href=");
    expect(outsideMarkup).toContain(
      '<span class="app-markdown-link app-markdown-inert-link">Secret</span>',
    );
  });

  it("does not auto-link bare workspace paths when no open action is available", () => {
    const markup = renderMarkdown(
      "See C:/Development/alpartis.morgana/app.alpartis.cloud/src/branch.dto.ts:27.",
      {
        workspaceRoot: "C:\\Development\\alpartis.morgana\\app.alpartis.cloud",
      },
    );

    expect(markup).not.toContain("data-workspace-path");
    expect(markup).not.toContain("<button");
    expect(markup).toContain("src/branch.dto.ts:27.");
  });

  it("renders safe links and images defensively while degrading invalid targets", () => {
    const markup = renderMarkdown(`[site](https://example.com "Example")

<https://example.org/path?q=1>

https://example.net/bare

[fragment](#section)

[unsafe](javascript:alert%281%29)

![diagram](https://example.com/diagram.png "Diagram")

![blocked](javascript:alert%281%29)
`);

    expect(markup).toContain(
      'title="Example" href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain(
      'href="https://example.org/path?q=1" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain('href="https://example.net/bare"');
    expect(markup).toContain('href="#section" class="app-markdown-link"');
    expect(markup).not.toContain('href="#section" target="_blank"');
    expect(markup).toContain(
      '<span class="app-markdown-link app-markdown-inert-link">unsafe</span>',
    );
    expect(markup).toContain(
      'src="https://example.com/diagram.png" alt="diagram" loading="lazy" decoding="async" referrerPolicy="no-referrer"',
    );
    expect(markup).toContain(
      '<span role="img" aria-label="blocked" class="app-markdown-image-fallback">blocked</span>',
    );
    expect(markup).not.toContain('src=""');
  });

  it("keeps context-specific component overrides and sanitizes their URLs", () => {
    const markup = renderMarkdown(
      "# Heading\n\n[unsafe](javascript:alert%281%29)",
      {
        className: "context-markdown",
        components: {
          h1: ({ children }) =>
            createElement("h2", { "data-level": "1" }, children),
          a: ({ children, href }) =>
            createElement("span", { "data-rendered-href": href }, children),
        },
      },
    );

    expect(markup).toContain(
      "app-markdown min-w-0 leading-6 wrap-break-word context-markdown",
    );
    expect(markup).toContain('<h2 data-level="1">Heading</h2>');
    expect(markup).toContain('<span data-rendered-href="">unsafe</span>');
  });

  it("preserves emphasis, escaping, entities, Unicode, and structured finding fields", () => {
    const markup =
      renderMarkdown(`***both***, ~one~, ~~removed~~, and \\*literal\\*.

&copy; &amp; Ελληνικά 你好 👩🏽‍💻

**Severity:** High
`);

    expect(markup).toContain("<em><strong>both</strong></em>");
    expect(markup).toContain("<del>one</del>");
    expect(markup).toContain("<del>removed</del>");
    expect(markup).toContain("*literal*");
    expect(markup).toContain("© &amp; Ελληνικά 你好 👩🏽‍💻");
    expect(markup).toContain('data-md-field="severity"');
  });

  it("renders malformed, deeply nested, and very long input without throwing", () => {
    const nestedQuote = `${"> ".repeat(48)}Deep **value`;
    const nestedList = Array.from(
      { length: 24 },
      (_, index) => `${"    ".repeat(index)}- level ${index}`,
    ).join("\n");
    const longValue = `start ${"界".repeat(50_000)} end`;

    expect(() =>
      renderMarkdown(`${nestedQuote}\n\n${nestedList}\n\n[broken](<target\n`),
    ).not.toThrow();
    const longMarkup = renderMarkdown(longValue);
    expect(longMarkup).toContain("start ");
    expect(longMarkup).toContain(" end</p>");
    expect(longMarkup.length).toBeGreaterThan(50_000);
  });

  it("keeps raw HTML inert, renders footnotes, and leaves unsupported math readable", () => {
    const markup = renderMarkdown(`<script>alert("xss")</script>

<img src=x onerror="alert(1)">

Term[^1] and $x^2$.

[^1]: Footnote text
`);

    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img src=");
    expect(markup).toContain(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain('data-footnote-ref="true"');
    expect(markup).toContain('data-footnotes="true"');
    expect(markup).toContain("Footnote text");
    expect(markup).toContain("and $x^2$.");
  });

  it("uses unique footnote targets across Markdown surfaces", () => {
    const footnote = "Reference[^1]\n\n[^1]: Detail";
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(MarkdownContent, { content: footnote }),
        createElement(MarkdownContent, { content: footnote }),
      ),
    );
    const targets = [
      ...markup.matchAll(/data-footnote-ref="true"[^>]*href="#([^"]+)"/gu),
    ].map((match) => match[1]);

    expect(targets).toHaveLength(2);
    expect(new Set(targets).size).toBe(2);
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
      '<p class="app-markdown-paragraph">Normal prose and C:/Other/secret.ts:1 stay unchanged.</p>',
    );
  });
});
