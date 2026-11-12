import { describe, expect, it } from "vitest";
import {
  issueIdentifierPattern,
  linkIssueIdentifiers,
  type MarkdownNode,
} from "./issue-links";

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

describe("issue identifier links", () => {
  it("links identifiers of known teams in text", () => {
    const tree = paragraph({
      type: "text",
      value: "PRD-12 blocks ENG-3, but ISO-8601 and prd-4 stay text.",
    });
    linkIssueIdentifiers(tree, issueIdentifierPattern(["PRD", "ENG"])!);
    expect(tree.children![0]!.children).toEqual([
      {
        type: "link",
        url: "/cloud/issues/PRD-12",
        children: [{ type: "text", value: "PRD-12" }],
      },
      { type: "text", value: " blocks " },
      {
        type: "link",
        url: "/cloud/issues/ENG-3",
        children: [{ type: "text", value: "ENG-3" }],
      },
      { type: "text", value: ", but ISO-8601 and prd-4 stay text." },
    ]);
  });

  it("leaves code, existing links and longer tokens untouched", () => {
    const tree = paragraph(
      { type: "inlineCode", value: "PRD-1" },
      {
        type: "link",
        url: "/cloud/issues/abc",
        children: [{ type: "text", value: "PRD-2" }],
      },
      { type: "text", value: "XPRD-3 PRD-4a /PRD-5 PRD-6." },
    );
    linkIssueIdentifiers(tree, issueIdentifierPattern(["PRD"])!);
    const children = tree.children![0]!.children!;
    expect(children[0]).toEqual({ type: "inlineCode", value: "PRD-1" });
    expect(children[1]!.children).toEqual([{ type: "text", value: "PRD-2" }]);
    expect(children.slice(2)).toEqual([
      { type: "text", value: "XPRD-3 PRD-4a /PRD-5 " },
      {
        type: "link",
        url: "/cloud/issues/PRD-6",
        children: [{ type: "text", value: "PRD-6" }],
      },
      { type: "text", value: "." },
    ]);
  });

  it("does nothing without valid team keys", () => {
    expect(issueIdentifierPattern([])).toBeNull();
    expect(issueIdentifierPattern(["bad key"])).toBeNull();
  });
});
