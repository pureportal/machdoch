import {
  autoMergeDecision,
  codeOwnerTeams,
  codeOwnersPaths,
  parseCodeOwners,
  type AutoMergeDecision,
} from "../../../lib/auto-merge";
import type { GitClient, GitPullRequestRecord } from "./git-client";

async function codeOwnersText(
  client: GitClient,
  fullName: string,
  ref: string,
): Promise<string> {
  for (const path of codeOwnersPaths) {
    const text = await client.fileText(fullName, path, ref);
    if (text !== null) return text;
  }
  return "";
}

export async function mergeReadiness(
  client: GitClient,
  fullName: string,
  pullRequest: GitPullRequestRecord,
): Promise<AutoMergeDecision> {
  const policy = await client.mergePolicy(fullName, pullRequest.baseRef);
  const reviewed = policy.codeOwnerReviews || policy.requiredApprovals > 0;
  const [checks, reviews, files, owners] = await Promise.all([
    client.checks(fullName, pullRequest.number, pullRequest.headSha),
    reviewed ? client.reviews(fullName, pullRequest.number) : [],
    policy.codeOwnerReviews ? client.files(fullName, pullRequest.number) : [],
    policy.codeOwnerReviews
      ? codeOwnersText(client, fullName, pullRequest.baseRef)
      : "",
  ]);
  const rules = parseCodeOwners(owners);
  const changed = files.map((file) => file.filename);
  const teams = new Map(
    await Promise.all(
      codeOwnerTeams(rules, changed).map(
        async (team) => [team, await client.teamMembers(team)] as const,
      ),
    ),
  );
  return autoMergeDecision({
    policy,
    runs: checks.runs,
    reviews,
    files: changed,
    codeOwners: rules,
    teams,
  });
}
