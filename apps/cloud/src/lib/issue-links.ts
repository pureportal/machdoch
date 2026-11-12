export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const skippedNodes = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

export const issueIdentifierFormat = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,7}$/;

export function issueHref(identifier: string): string {
  return `/cloud/issues/${identifier}`;
}

export function issueIdentifierPattern(keys: readonly string[]): RegExp | null {
  const valid = keys.filter((key) => /^[A-Z][A-Z0-9]{1,9}$/.test(key));
  return valid.length
    ? new RegExp(`(?<![\\w/-])(?:${valid.join("|")})-\\d{1,7}(?![\\w-])`, "g")
    : null;
}

function linkedText(value: string, pattern: RegExp): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > cursor)
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    nodes.push({
      type: "link",
      url: issueHref(match[0]),
      children: [{ type: "text", value: match[0] }],
    });
    cursor = match.index + match[0].length;
  }
  if (!nodes.length) return [{ type: "text", value }];
  if (cursor < value.length)
    nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

export function linkIssueIdentifiers(
  node: MarkdownNode,
  pattern: RegExp,
): void {
  if (skippedNodes.has(node.type) || !node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string")
      return linkedText(child.value, pattern);
    linkIssueIdentifiers(child, pattern);
    return [child];
  });
}

export function issueLinkRemarkPlugin(keys: readonly string[]) {
  const pattern = issueIdentifierPattern(keys);
  return () =>
    (tree: MarkdownNode): void => {
      if (pattern) linkIssueIdentifiers(tree, pattern);
    };
}
