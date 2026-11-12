export const issueDisplayProperties = [
  { id: "id", label: "ID" },
  { id: "labels", label: "Labels" },
  { id: "pullRequest", label: "Pull request" },
  { id: "project", label: "Project" },
  { id: "cycle", label: "Cycle" },
  { id: "due", label: "Due date" },
  { id: "estimate", label: "Estimate" },
  { id: "assignee", label: "Assignee" },
  { id: "created", label: "Created" },
  { id: "updated", label: "Updated" },
] as const;
export type IssueDisplayProperty =
  (typeof issueDisplayProperties)[number]["id"];

export const defaultHiddenIssueProperties: readonly IssueDisplayProperty[] = [
  "created",
];

const knownProperties = new Set<string>(
  issueDisplayProperties.map((property) => property.id),
);

export function parseHiddenIssueProperties(
  stored: string | null,
): ReadonlySet<IssueDisplayProperty> {
  if (stored === null) return new Set(defaultHiddenIssueProperties);
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set(defaultHiddenIssueProperties);
    return new Set(
      parsed.filter(
        (entry): entry is IssueDisplayProperty =>
          typeof entry === "string" && knownProperties.has(entry),
      ),
    );
  } catch {
    return new Set(defaultHiddenIssueProperties);
  }
}

export function toggleIssueProperty(
  hidden: ReadonlySet<IssueDisplayProperty>,
  property: IssueDisplayProperty,
): IssueDisplayProperty[] {
  return issueDisplayProperties
    .map((entry) => entry.id)
    .filter((id) => (id === property ? !hidden.has(id) : hidden.has(id)));
}
