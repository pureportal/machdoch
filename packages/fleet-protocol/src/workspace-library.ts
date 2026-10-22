import { z } from "zod";

export const workspaceLibraryCapability = "workspace-library.v1";

export interface KnowledgeSource {
  path: string;
  content: string;
  fingerprint: string;
}

const id = z.string().uuid();
const text = (maximum: number) => z.string().trim().max(maximum);
const sourceSchema = z.strictObject({
  id,
  title: text(300).min(1),
  uri: text(2048)
    .min(1)
    .refine((value) => {
      if (/^https?:\/\//iu.test(value)) {
        try {
          const url = new URL(value);
          return !url.username && !url.password;
        } catch {
          return false;
        }
      }
      return (
        !/^(?:[\\/]|[a-z]:)/iu.test(value) &&
        !value.split(/[\\/]/u).includes("..") &&
        !value.includes("\0")
      );
    }),
  excerpt: text(12_000),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  checkedAt: z.number().int().nonnegative().optional(),
});

export const researchProjectInputSchema = z
  .strictObject({
    id: id.optional(),
    revision: z.number().int().nonnegative(),
    title: text(200).min(1),
    question: text(4000).min(1),
    notes: text(100_000),
    status: z.enum(["active", "complete", "archived"]),
    sources: z.array(sourceSchema).max(200),
    findings: z
      .array(
        z.strictObject({
          id,
          claim: text(4000).min(1),
          sourceIds: z.array(id).max(30),
          status: z.enum(["supported", "uncertain", "contradicted"]),
        }),
      )
      .max(200),
  })
  .superRefine((project, context) => {
    const ids = new Set(project.sources.map((source) => source.id));
    if (
      ids.size !== project.sources.length ||
      new Set(project.findings.map((finding) => finding.id)).size !==
        project.findings.length
    )
      context.addIssue({
        code: "custom",
        message: "Source and finding identifiers must be unique.",
      });
    for (const finding of project.findings) {
      if (
        finding.sourceIds.some((sourceId) => !ids.has(sourceId)) ||
        (finding.status === "supported" && finding.sourceIds.length === 0)
      )
        context.addIssue({
          code: "custom",
          message: "Link supported findings to sources in this project.",
        });
    }
  });

export type ResearchProjectInput = z.infer<typeof researchProjectInputSchema>;
export interface ResearchProject extends ResearchProjectInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeHit {
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  fingerprint: string;
}
export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  indexedFiles: number;
  skippedFiles: number;
  indexedAt: number;
}
export interface ResearchSourceCheck {
  sourceId: string;
  state: "current" | "changed" | "missing" | "unverified";
}

export const workspaceLibraryRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("source"), path: text(2048).min(1) }),
  z.strictObject({
    action: z.literal("search"),
    query: text(1000).min(1),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.strictObject({ action: z.literal("index") }),
  z.strictObject({ action: z.literal("projects") }),
  z.strictObject({ action: z.literal("project"), id }),
  z.strictObject({
    action: z.literal("save-project"),
    project: researchProjectInputSchema,
  }),
  z.strictObject({
    action: z.literal("delete-project"),
    id,
    revision: z.number().int().positive(),
  }),
  z.strictObject({ action: z.literal("check-sources"), id }),
]);
export type WorkspaceLibraryRequest = z.infer<
  typeof workspaceLibraryRequestSchema
>;
