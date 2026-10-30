import type {
  ClientAgent,
  ExecutionProfile,
} from "@machdoch/fleet-protocol/cloud-execution";

export const executionTargetLabels: Record<ExecutionProfile["target"], string> =
  {
    cloud: "Cloud sandbox",
    "client-linux": "Client sandbox",
    client: "Linked client",
  };

export const clientAgentLabels: Record<ClientAgent, string> = {
  machdoch: "Machdoch",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude Code",
};

export function profileAgentLabel(profile: ExecutionProfile): string {
  if (profile.target !== "client") return profile.model;
  const agent = clientAgentLabels[profile.agent];
  return profile.model ? `${agent} · ${profile.model}` : agent;
}
