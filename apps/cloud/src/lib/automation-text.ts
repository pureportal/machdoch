export type AutomationVariables = Record<string, unknown>;

export const automationVariableNames = [
  "issue.identifier",
  "issue.title",
  "issue.description",
  "issue.status",
  "issue.priority",
  "issue.url",
  "actor.name",
  "comment.body",
  "comment.author",
  "comment.url",
  "pullRequest.title",
  "pullRequest.url",
  "pullRequest.stage",
  "pullRequest.number",
  "pullRequest.author",
  "pullRequest.headRef",
  "pullRequest.baseRef",
  "event.kind",
  "repository.name",
  "repository.url",
  "branch",
  "sender",
  "tag",
  "push.commits",
  "push.compareUrl",
  "review.state",
  "review.body",
  "review.author",
  "parent.number",
  "parent.title",
  "parent.headRef",
  "release.title",
  "release.version",
  "release.url",
  "payload",
  "agent.answer",
  "run.automation",
  "run.outcome",
  "run.error",
  "automation.name",
  "date",
] as const;

function lookup(variables: AutomationVariables, path: string): unknown {
  let value: unknown = variables;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function renderAutomationText(
  template: string,
  variables: AutomationVariables,
  maximumLength: number,
): string {
  const rendered = template.replace(
    /\{\{\s*([A-Za-z][\w]*(?:\.[\w-]+)*)\s*\}\}/g,
    (_, path: string) => {
      const value = lookup(variables, path);
      if (value === undefined || value === null) return "";
      return typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
    },
  );
  return rendered.length > maximumLength
    ? `${rendered.slice(0, maximumLength - 1)}…`
    : rendered;
}
