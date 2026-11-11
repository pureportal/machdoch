import type {
  CloudActor,
  CloudCycle,
  CloudIssueSummary,
  CloudMember,
  CloudProject,
  CloudTeam,
  CloudWorkspace,
} from "../../../lib/cloud-contract";
import type { CloudWorkflowStatus } from "../../../lib/cloud-workflow-contract";
import { isCloudError } from "../access";

export class AgentLookupError extends Error {}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export class AgentWorkspace {
  constructor(
    readonly actor: CloudActor,
    readonly snapshot: CloudWorkspace,
  ) {}

  team(reference: string): CloudTeam {
    const key = normalized(reference);
    const team = this.snapshot.teams.find(
      (entry) =>
        normalized(entry.key) === key ||
        normalized(entry.name) === key ||
        entry.id === reference,
    );
    if (!team)
      throw new AgentLookupError(
        `No accessible team matches "${reference}". Known teams: ${this.snapshot.teams.map((entry) => entry.key).join(", ") || "none"}.`,
      );
    return team;
  }

  teamById(id: string): CloudTeam | undefined {
    return this.snapshot.teams.find((team) => team.id === id);
  }

  member(reference: string): CloudMember {
    const key = normalized(reference);
    if (key === "me")
      return this.snapshot.members.find(
        (member) => member.id === this.actor.userId,
      )!;
    const member = this.snapshot.members.find(
      (entry) => entry.id === reference || normalized(entry.name) === key,
    );
    if (member) return member;
    const partial = this.snapshot.members.filter((entry) =>
      normalized(entry.name).includes(key),
    );
    if (partial.length === 1) return partial[0]!;
    throw new AgentLookupError(
      partial.length
        ? `"${reference}" matches several members: ${partial.map((entry) => entry.name).join(", ")}.`
        : `No member matches "${reference}".`,
    );
  }

  memberName(id: string | null): string | null {
    return id
      ? (this.snapshot.members.find((member) => member.id === id)?.name ?? null)
      : null;
  }

  project(reference: string, teamId?: string): CloudProject {
    const key = normalized(reference);
    const candidates = this.snapshot.projects.filter(
      (project) => !teamId || project.teamId === teamId,
    );
    const project =
      candidates.find((entry) => entry.id === reference) ??
      candidates.find((entry) => normalized(entry.name) === key) ??
      singleMatch(
        candidates.filter((entry) => normalized(entry.name).includes(key)),
      );
    if (!project)
      throw new AgentLookupError(
        `No accessible project matches "${reference}".`,
      );
    return project;
  }

  projectName(id: string | null): string | null {
    return id
      ? (this.snapshot.projects.find((project) => project.id === id)?.name ??
          null)
      : null;
  }

  cycle(reference: string, teamId?: string): CloudCycle {
    const key = normalized(reference);
    const candidates = this.snapshot.cycles.filter(
      (cycle) => !teamId || cycle.teamId === teamId,
    );
    const cycle =
      candidates.find((entry) => entry.id === reference) ??
      (key === "current"
        ? singleMatch(candidates.filter((entry) => entry.status === "active"))
        : key === "next" || key === "upcoming"
          ? candidates
              .filter((entry) => entry.status === "planned")
              .sort((left, right) =>
                left.startsOn.localeCompare(right.startsOn),
              )[0]
          : undefined) ??
      candidates.find((entry) => normalized(entry.name) === key) ??
      singleMatch(
        candidates.filter((entry) => normalized(entry.name).includes(key)),
      );
    if (!cycle)
      throw new AgentLookupError(`No accessible cycle matches "${reference}".`);
    return cycle;
  }

  cycleName(id: string | null): string | null {
    return id
      ? (this.snapshot.cycles.find((cycle) => cycle.id === id)?.name ?? null)
      : null;
  }

  statuses(teamId: string): CloudWorkflowStatus[] {
    return (
      this.snapshot.workflows
        .find((workflow) => workflow.teamId === teamId)
        ?.statuses.filter((status) => !status.archived) ?? []
    );
  }

  status(teamId: string, reference: string): CloudWorkflowStatus {
    const key = normalized(reference);
    const statuses = this.statuses(teamId);
    const status =
      statuses.find((entry) => normalized(entry.name) === key) ??
      statuses.find((entry) => entry.category === key);
    if (!status)
      throw new AgentLookupError(
        `No status "${reference}" in this team. Statuses: ${statuses.map((entry) => entry.name).join(", ")}.`,
      );
    return status;
  }

  issueSummary(issue: CloudIssueSummary) {
    return {
      identifier: issue.identifier,
      link: `/cloud/issues/${issue.id}`,
      title: issue.title,
      status: issue.statusName,
      statusCategory: issue.state,
      priority: issue.priority,
      assignee: this.memberName(issue.assigneeId),
      project: this.projectName(issue.projectId),
      cycle: this.cycleName(issue.cycleId),
      estimate: issue.estimate,
      dueOn: issue.dueOn,
      labels: issue.labels.map((label) => label.name),
      updatedAt: issue.updatedAt.slice(0, 10),
    };
  }
}

function singleMatch<T>(entries: T[]): T | undefined {
  return entries.length === 1 ? entries[0] : undefined;
}

export function agentFailureMessage(error: unknown): string | null {
  if (error instanceof AgentLookupError) return error.message;
  if (isCloudError(error) && error.status < 500) return error.message;
  return null;
}
