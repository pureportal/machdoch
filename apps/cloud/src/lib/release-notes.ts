export interface ReleaseNoteIssue {
  identifier: string;
  title: string;
  team: string;
  pullRequests: { number: number; url: string }[];
}

export interface ReleaseNotes {
  internal: string;
  external: string;
}

export function releaseNotes(
  heading: string,
  issues: readonly ReleaseNoteIssue[],
): ReleaseNotes {
  const teams = new Map<string, ReleaseNoteIssue[]>();
  for (const issue of [...issues].sort((left, right) =>
    left.identifier.localeCompare(right.identifier, undefined, {
      numeric: true,
    }),
  ))
    teams.set(issue.team, [...(teams.get(issue.team) ?? []), issue]);
  const internal = [`# ${heading}`];
  for (const [team, teamIssues] of [...teams].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    internal.push("", `## ${team}`);
    for (const issue of teamIssues) {
      const links = issue.pullRequests
        .map((pullRequest) => `[#${pullRequest.number}](${pullRequest.url})`)
        .join(", ");
      internal.push(
        `- ${issue.identifier} ${issue.title}${links ? ` (${links})` : ""}`,
      );
    }
  }
  const titles = [
    ...new Set([...teams.values()].flat().map((issue) => issue.title.trim())),
  ];
  return {
    internal: internal.join("\n"),
    external: [`# ${heading}`, "", ...titles.map((title) => `- ${title}`)].join(
      "\n",
    ),
  };
}
