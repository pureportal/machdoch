import type {
  AgentEntity,
  AgentEntityKind,
  AgentStep,
} from "./cloud-chat-contract";

const entityRoutes: Record<AgentEntityKind, string> = {
  issue: "issues",
  project: "projects",
  initiative: "initiatives",
  cycle: "cycles",
  team: "teams",
  pull_request: "pull-requests",
  release: "releases",
  loop: "loops",
};

export function agentEntityHref(entity: Pick<AgentEntity, "kind" | "id">) {
  return `/cloud/${entityRoutes[entity.kind]}/${entity.id}`;
}

export type AgentStepSegment = string | AgentEntity;

export function agentStepSegments(
  step: Pick<AgentStep, "label" | "entities">,
): {
  label: AgentStepSegment[];
  trailing: AgentEntity[];
} {
  const label: AgentStepSegment[] = [step.label];
  const trailing: AgentEntity[] = [];
  for (const entity of step.entities ?? []) {
    const index = label.findIndex(
      (segment) =>
        typeof segment === "string" && segment.includes(entity.label),
    );
    if (index < 0) {
      trailing.push(entity);
      continue;
    }
    const text = label[index] as string;
    const start = text.indexOf(entity.label);
    label.splice(
      index,
      1,
      ...[
        text.slice(0, start),
        entity,
        text.slice(start + entity.label.length),
      ].filter((segment) => segment !== ""),
    );
  }
  return { label, trailing };
}
