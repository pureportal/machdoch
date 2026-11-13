const taskMarker = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/;

export function toggleTaskListItem(markdown: string, offset: number): string {
  const lineStart = markdown.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const lineEnd = markdown.indexOf("\n", offset);
  const line = markdown.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const match = taskMarker.exec(line);
  if (!match) return markdown;
  const position = lineStart + match[1]!.length + 1;
  const checked = match[2] !== " ";
  return `${markdown.slice(0, position)}${checked ? " " : "x"}${markdown.slice(position + 1)}`;
}

export function taskListProgress(markdown: string): {
  completed: number;
  total: number;
} {
  let completed = 0;
  let total = 0;
  for (const line of markdown.split("\n")) {
    const match = taskMarker.exec(line);
    if (!match) continue;
    total++;
    if (match[2] !== " ") completed++;
  }
  return { completed, total };
}

export function issueBranchName(identifier: string, title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return [identifier.toLowerCase(), slug].filter(Boolean).join("-");
}

const sessionTitleLength = 240;

export function issueSessionTitle(identifier: string, title: string): string {
  return `${identifier} ${title}`.slice(0, sessionTitleLength).trim();
}

export function issuePrompt(
  issue: {
    identifier: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
  },
  url: string,
): string {
  const description = issue.description.trim();
  const criteria = issue.acceptanceCriteria.trim();
  return [
    `${issue.identifier}: ${issue.title}`,
    description,
    criteria && `Acceptance criteria:\n${criteria}`,
    url,
  ]
    .filter(Boolean)
    .join("\n\n");
}
