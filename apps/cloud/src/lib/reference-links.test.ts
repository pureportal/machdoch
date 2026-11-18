import { describe, expect, it } from "vitest";
import {
  issueReferenceRule,
  linkReferences,
  pullRequestReferenceRule,
  type MarkdownNode,
} from "./reference-links";

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

describe("reference links", () => {
  it("links identifiers of known teams in text", () => {
    const tree = paragraph({
      type: "text",
      value: "PRD-12 blocks ENG-3, but ISO-8601 and prd-4 stay text.",
    });
    linkReferences(tree, issueReferenceRule(["PRD", "ENG"])!);
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
    linkReferences(tree, issueReferenceRule(["PRD"])!);
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
    expect(issueReferenceRule([])).toBeNull();
    expect(issueReferenceRule(["bad key"])).toBeNull();
  });

  it("links pull request references to their Machdoch page", () => {
    const tree = paragraph({
      type: "text",
      value:
        "Fixed in machdoch/landing#12 and acme/api.v2#3, not in https://x.test/a/b#4 or a/b#5c.",
    });
    linkReferences(tree, pullRequestReferenceRule);
    expect(tree.children![0]!.children).toEqual([
      { type: "text", value: "Fixed in " },
      {
        type: "link",
        url: "/cloud/pull-requests/reference/machdoch/landing/12",
        children: [{ type: "text", value: "machdoch/landing#12" }],
      },
      { type: "text", value: " and " },
      {
        type: "link",
        url: "/cloud/pull-requests/reference/acme/api.v2/3",
        children: [{ type: "text", value: "acme/api.v2#3" }],
      },
      {
        type: "text",
        value: ", not in https://x.test/a/b#4 or a/b#5c.",
      },
    ]);
  });
});
