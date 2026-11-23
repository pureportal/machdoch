import { z } from "zod";
import { cloudId, revision } from "./cloud-contract";

export const pipelineTypes = ["continuous", "scheduled"] as const;
export type PipelineType = (typeof pipelineTypes)[number];
export const pipelineSources = [
  "deployment",
  "workflow_run",
  "tag",
  "webhook",
] as const;
export type PipelineSource = (typeof pipelineSources)[number];
export const pipelineSourceLabels: Record<PipelineSource, string> = {
  deployment: "Deployment",
  workflow_run: "Workflow run",
  tag: "Tag",
  webhook: "Webhook",
};

const sha = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{40}$/u);
const environmentName = z.string().trim().min(1).max(60);

const pipelineFields = {
  name: z.string().trim().min(1).max(100),
  teamIds: z.array(cloudId).min(1).max(20),
  repositoryId: cloudId.nullable(),
  paths: z.array(z.string().trim().min(1).max(300)).max(30),
  type: z.enum(pipelineTypes),
  source: z.enum(pipelineSources),
  environments: z.array(environmentName).min(1).max(10),
};

function checkPipeline(
  value: {
    source: PipelineSource;
    repositoryId: string | null;
    environments: string[];
  },
  context: z.RefinementCtx,
): void {
  if (value.source !== "webhook" && !value.repositoryId)
    context.addIssue({
      code: "custom",
      path: ["repositoryId"],
      message: "Choose a repository.",
    });
  const names = value.environments.map((name) => name.toLowerCase());
  if (new Set(names).size !== names.length)
    context.addIssue({
      code: "custom",
      path: ["environments"],
      message: "Use each environment once.",
    });
}

export const pipelineInputSchema = z
  .strictObject(pipelineFields)
  .superRefine(checkPipeline);
export type PipelineInput = z.output<typeof pipelineInputSchema>;

export const pipelineUpdateSchema = z
  .strictObject({ ...pipelineFields, revision, archived: z.boolean() })
  .superRefine(checkPipeline);
export type PipelineUpdate = z.output<typeof pipelineUpdateSchema>;

export const pipelineReleaseIssueSchema = z.strictObject({
  issueId: cloudId,
});

export const pipelineDeploymentSchema = z.strictObject({
  environment: environmentName.nullable().default(null),
  version: z.string().trim().min(1).max(40),
  sha: sha.nullable().default(null),
  externalId: z.string().trim().min(1).max(200).nullable().default(null),
  url: z
    .url({ protocol: /^https?$/u })
    .max(500)
    .nullable()
    .default(null),
  commits: z
    .array(
      z.strictObject({
        sha,
        message: z.string().max(10_000),
        paths: z.array(z.string().max(500)).max(500).default([]),
      }),
    )
    .max(500)
    .default([]),
});
export type PipelineDeployment = z.output<typeof pipelineDeploymentSchema>;

export const releasePolicySchema = z.strictObject({
  completeOnRelease: z.boolean(),
});

export const pipelineLaunchSchema = z.strictObject({
  productId: cloudId,
});

export interface PipelineSummary {
  id: string;
  name: string;
  teams: { id: string; name: string; key: string }[];
  repository: string | null;
  type: PipelineType;
  source: PipelineSource;
  environments: string[];
  releaseCount: number;
  latestRelease: {
    id: string;
    version: string;
    environment: string;
    deployedAt: string;
  } | null;
  archived: boolean;
}

export interface CloudPipeline extends PipelineSummary {
  repositoryId: string | null;
  paths: string[];
  revision: number;
  releases: PipelineReleaseSummary[];
}

export interface PipelineReleaseSummary {
  id: string;
  version: string;
  environment: string;
  deployedAt: string;
  fromSha: string | null;
  toSha: string | null;
  evidenceUrl: string | null;
  issueCount: number;
}

export interface PipelineReleaseIssue {
  issueId: string;
  identifier: string;
  title: string;
  state: string;
  source: "automatic" | "manual";
  pullRequests: { number: number; url: string; title: string }[];
}

export interface PipelineReleaseDetail extends PipelineReleaseSummary {
  pipelineId: string;
  pipelineName: string;
  issues: PipelineReleaseIssue[];
  notes: { internal: string; external: string };
}

export interface CreatedPipeline {
  id: string;
  webhookToken: string | null;
}
