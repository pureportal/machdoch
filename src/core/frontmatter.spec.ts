import { parseMarkdownDocument } from "./frontmatter.ts";

describe("parseMarkdownDocument", () => {
  it("returns a trimmed body when no frontmatter is present", () => {
    const document = parseMarkdownDocument("\n  just a markdown body  \n");

    expect(document).toEqual({
      attributes: {},
      body: "just a markdown body",
    });
  });

  it("parses quoted strings, booleans, numbers, and arrays", () => {
    const document = parseMarkdownDocument(`---
name: "debug-build"
enabled: true
priority: 80
keywords: ["security", 'auth', token]
---
Use the smallest safe change.
`);

    expect(document.attributes).toEqual({
      name: "debug-build",
      enabled: true,
      priority: 80,
      keywords: ["security", "auth", "token"],
    });
    expect(document.body).toBe("Use the smallest safe change.");
  });

  it("ignores comments and malformed lines without crashing", () => {
    const document = parseMarkdownDocument(`---
# comment
name: sample
not-valid
empty: []
---
Body
`);

    expect(document.attributes).toEqual({
      name: "sample",
      empty: [],
    });
    expect(document.body).toBe("Body");
  });

  it("parses YAML-style block arrays used by prompt frontmatter", () => {
    const document = parseMarkdownDocument(`---
name: debug-build
tools:
  - filesystem
  - terminal
inputs:
  - error
  - logs
---
Prompt body.
`);

    expect(document.attributes).toEqual({
      name: "debug-build",
      tools: ["filesystem", "terminal"],
      inputs: ["error", "logs"],
    });
    expect(document.body).toBe("Prompt body.");
  });

  it("skips blank lines and comments inside block arrays and allows an empty body", () => {
    const document = parseMarkdownDocument(`---
inputs:
  - "error"

  # comment
  - 'logs'
---
`);

    expect(document.attributes).toEqual({
      inputs: ["error", "logs"],
    });
    expect(document.body).toBe("");
  });
});
