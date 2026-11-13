import type { z } from "zod";
import type {
  AgentAction,
  AgentQuestion,
} from "../../../lib/cloud-chat-contract";
import type { CloudPlanning } from "../planning";
import type { CloudProjects } from "../projects";
import type { CloudCycles } from "../cycles";
import type { CloudIssueRelations } from "../relations";
import type { CloudComments } from "../comments";
import type { CloudLabels } from "../labels";
import type { CloudProjectMilestones } from "../project-milestones";
import type { CloudProjectUpdates } from "../project-updates";
import type { CloudInitiatives } from "../initiatives";
import type { CloudTriage } from "../triage";
import type { CloudRuns } from "../execution/runs";
import type { CloudGitPullRequests } from "../git/pull-requests";
import type { CloudReleases } from "../releases/releases";
import type { CloudProducts } from "../releases/products";
import type { CloudReleaseMedia } from "../releases/release-media";
import type { CloudAutomations } from "../automation/automations";
import type { CloudExecutionProfiles } from "../execution/profiles";
import type { CloudAiProviders } from "./providers";
import type { CloudAgentSession } from "./agent-tools";
import type { CloudAttachments } from "../attachments/attachments";
import type { CloudClients } from "../clients/clients";

export interface AgentServices {
  planning: CloudPlanning;
  projects: CloudProjects;
  cycles: CloudCycles;
  relations: CloudIssueRelations;
  comments: CloudComments;
  labels: CloudLabels;
  milestones: CloudProjectMilestones;
  projectUpdates: CloudProjectUpdates;
  initiatives: CloudInitiatives;
  triage: CloudTriage;
  runs: CloudRuns;
  pullRequests: CloudGitPullRequests;
  releases: CloudReleases;
  products: CloudProducts;
  releaseMedia: CloudReleaseMedia;
  automations: CloudAutomations;
  providers: CloudAiProviders;
  profiles: CloudExecutionProfiles;
  attachments: CloudAttachments;
  clients: CloudClients;
}

export type AgentProposal = Omit<
  AgentAction,
  "id" | "state" | "error" | "result"
>;

export interface AgentToolOutcome {
  output: unknown;
  label: string;
  question?: AgentQuestion;
  proposal?: AgentProposal;
}

export interface AgentTool<T = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  terminal?: boolean;
  run(session: CloudAgentSession, input: T): Promise<AgentToolOutcome>;
}

export function agentTool<T>(tool: AgentTool<T>): AgentTool {
  return tool as unknown as AgentTool;
}
