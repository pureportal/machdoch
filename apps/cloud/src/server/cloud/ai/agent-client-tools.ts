import { z } from "zod";
import type { CloudClientDevice } from "../clients/clients";
import { agentTool, type AgentTool } from "./agent-tool";
import {
  field,
  issueReference,
  markdownField,
  pendingOutput,
  reference,
} from "./agent-proposal-helpers";
import type { CloudAgentSession } from "./agent-tools";
import { AgentLookupError } from "./agent-workspace";

const lookupTimeoutMs = 10_000;

function clientsFor(session: CloudAgentSession): Promise<CloudClientDevice[]> {
  return session.services.clients.list(
    session.actor,
    AbortSignal.timeout(lookupTimeoutMs),
  );
}

function matches(value: string, candidates: (string | undefined)[]): boolean {
  const key = value.trim().toLowerCase();
  return candidates.some((candidate) => candidate?.toLowerCase() === key);
}

export const clientTools: AgentTool[] = [
  agentTool({
    name: "list_clients",
    description:
      "List the connected Machdoch desktop clients that can run a session now, with their workspaces. Clients run their own agent with local files, tools, Git and the media studio for images and videos. Only owners and administrators can use clients.",
    schema: z.strictObject({}),
    async run(session) {
      const clients = await clientsFor(session);
      return {
        output: {
          clients: clients.map((client) => ({
            client: client.name,
            id: client.instanceId,
            workspaces: client.workspaces.map((workspace) => ({
              workspace: workspace.label,
              root: workspace.root,
            })),
          })),
        },
        label: `Found ${clients.length} client${clients.length === 1 ? "" : "s"}`,
      };
    },
  }),
  agentTool({
    name: "propose_client_session",
    description:
      "Propose starting a session on a connected client: its agent works in the chosen workspace with local files and tools, for example to implement an issue, fix a pull request or create images and videos. Use goal for larger, long-running work that should continue until the objective is met. With an issue, the client gets a link to upload the files it creates to that issue. Call list_clients first. Nothing starts until the user confirms.",
    schema: z.strictObject({
      client: reference.describe("Client name or ID from list_clients."),
      workspace: z
        .string()
        .trim()
        .min(1)
        .max(1_000)
        .describe("Workspace name or root from list_clients."),
      title: z.string().trim().min(1).max(120),
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .describe(
          "Complete instructions for the client agent, including the issue link and what done means.",
        ),
      goal: z
        .boolean()
        .default(false)
        .describe("Run in goal mode until the objective in the prompt is met."),
      issue: issueReference.optional(),
    }),
    async run(session, input) {
      const clients = await clientsFor(session);
      const client = clients.find((entry) =>
        matches(input.client, [entry.name, entry.instanceId]),
      );
      if (!client)
        throw new AgentLookupError(
          clients.length
            ? `No connected client is named ${input.client}. Clients: ${clients.map((entry) => entry.name).join(", ")}.`
            : "No client is connected.",
        );
      const workspace = client.workspaces.find((entry) =>
        matches(input.workspace, [entry.label, entry.root]),
      );
      if (!workspace)
        throw new AgentLookupError(
          `${client.name} has no workspace ${input.workspace}. Workspaces: ${client.workspaces.map((entry) => entry.label).join(", ")}.`,
        );
      const issue = input.issue
        ? await session.resolveIssue(input.issue)
        : undefined;
      return {
        output: pendingOutput,
        label: `Proposed a session on ${client.name}`,
        proposal: {
          kind: "client_session",
          title: input.title,
          fields: [
            { label: "Client", value: client.name },
            { label: "Workspace", value: workspace.label },
            { label: "Mode", value: input.goal ? "Goal" : "Single task" },
            ...field("Issue", issue?.identifier),
            ...markdownField("Prompt", input.prompt),
          ],
          instanceId: client.instanceId,
          deviceName: client.name,
          workspace: workspace.root,
          sessionTitle: input.title,
          prompt: input.prompt,
          goal: input.goal,
          issueId: issue?.id ?? null,
          identifier: issue?.identifier ?? null,
        },
      };
    },
  }),
];
