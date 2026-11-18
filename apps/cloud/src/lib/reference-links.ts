export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

export interface ReferenceRule {
  pattern: RegExp;
  href: (reference: string) => string;
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

export function pullRequestReferenceHref(
  repository: string,
  number: number,
): string {
  return `/cloud/pull-requests/reference/${repository}/${number}`;
}

export function issueReferenceRule(
  keys: readonly string[],
): ReferenceRule | null {
  const valid = keys.filter((key) => /^[A-Z][A-Z0-9]{1,9}$/.test(key));
  return valid.length
    ? {
        pattern: new RegExp(
          `(?<![\\w/-])(?:${valid.join("|")})-\\d{1,7}(?![\\w-])`,
          "g",
        ),
        href: issueHref,
      }
    : null;
}

export const pullRequestReferenceRule: ReferenceRule = {
  pattern:
    /(?<![\w./-])[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}#\d{1,7}(?![\w-])/g,
  href: (reference) => {
    const [repository, number] = reference.split("#");
    return pullRequestReferenceHref(repository!, Number(number));
  },
};

function linkedText(value: string, rule: ReferenceRule): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(rule.pattern)) {
    if (match.index > cursor)
      nodes.push({ type: "text", value: value.slice(cursor, match.index) });
    nodes.push({
      type: "link",
      url: rule.href(match[0]),
      children: [{ type: "text", value: match[0] }],
    });
    cursor = match.index + match[0].length;
  }
  if (!nodes.length) return [{ type: "text", value }];
  if (cursor < value.length)
    nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

export function linkReferences(node: MarkdownNode, rule: ReferenceRule): void {
  if (skippedNodes.has(node.type) || !node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string")
      return linkedText(child.value, rule);
    linkReferences(child, rule);
    return [child];
  });
}

export function referenceLinkRemarkPlugin(keys: readonly string[]) {
  const rules = [pullRequestReferenceRule, issueReferenceRule(keys)].filter(
    (rule): rule is ReferenceRule => rule !== null,
  );
  return () =>
    (tree: MarkdownNode): void => {
      for (const rule of rules) linkReferences(tree, rule);
    };
}
