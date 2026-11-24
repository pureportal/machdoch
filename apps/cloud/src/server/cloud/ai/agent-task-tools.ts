import { z } from "zod";
import { agentTool, type AgentTool } from "./agent-tool";
import {
  issueReference,
  markdownField,
  pendingOutput,
  reference,
} from "./agent-proposal-helpers";
import { AgentLookupError } from "./agent-workspace";

function repositoryName(url: string): string {
  return new URL(url).pathname.replace(/^\/|\.git$/gu, "");
}

export const taskTools: AgentTool[] = [
  agentTool({
    name: "propose_issue_task",
    description:
      "Propose starting an AI task that implements an issue in a sandbox and opens a pull request. When the issue's project has several repositories, pass the repository it belongs in. Put extra guidance for the task, such as how to test, into the issue description with propose_issue_update first. Nothing starts until the user confirms.",
    schema: z.strictObject({
      issue: issueReference,
      repository: reference
        .optional()
        .describe(
          "Repository such as owner/name, or the setup name. Required when the project has several repositories.",
        ),
    }),
    async run(session, input) {
      const issue = await session.resolveIssue(input.issue);
      if (!issue.projectId)
        throw new AgentLookupError(
          `${issue.identifier} has no project. Add it to a project with a repository first.`,
        );
      const profiles = (
        await session.services.profiles.list(session.actor, issue.projectId)
      ).filter(
        (profile) =>
          profile.enabled &&
          profile.target !== "client" &&
          session.repositories.allows(profile.repository),
      );
      if (!profiles.length)
        throw new AgentLookupError(
          `The project of ${issue.identifier} has no repository set up for AI tasks.`,
        );
      const key = input.repository?.trim().toLowerCase();
      const matching = key
        ? profiles.filter(
            (profile) =>
              profile.name.toLowerCase() === key ||
              repositoryName(profile.repository).toLowerCase() === key ||
              profile.repository.toLowerCase() === key,
          )
        : profiles;
      const choices = profiles
        .map((profile) => repositoryName(profile.repository))
        .join(", ");
      if (matching.length !== 1)
        throw new AgentLookupError(
          matching.length
            ? `Choose the repository for ${issue.identifier}: ${choices}.`
            : `No repository ${input.repository} is set up for this project. Repositories: ${choices}.`,
        );
      const profile = matching[0]!;
      const repository = repositoryName(profile.repository);
      return {
        output: pendingOutput,
        label: `Proposed an AI task for ${issue.identifier}`,
        proposal: {
          kind: "issue_task",
          title: `Implement ${issue.identifier}`,
          fields: [
            { label: "Issue", value: `${issue.identifier} ${issue.title}` },
            { label: "Repository", value: repository },
            ...markdownField("Acceptance criteria", issue.acceptanceCriteria),
          ],
          issueId: issue.id,
          identifier: issue.identifier,
          profileId: profile.id,
          repository,
        },
      };
    },
  }),
];
