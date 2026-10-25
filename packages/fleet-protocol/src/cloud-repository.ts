import { z } from "zod";

export const githubRepositorySchema = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "Use an HTTPS GitHub repository URL without credentials, query, or fragment.",
  )
  .refine(
    (value) =>
      !value
        .slice("https://github.com/".length)
        .split("/")
        .some((segment) => segment === "." || segment === ".."),
    "Use a repository owner and name.",
  );

export const repositoryRequestSchema = z
  .strictObject({
    id: z.uuid(),
    operation: z.enum(["advertise", "fetch"]),
    encoding: z.literal("gzip").optional(),
    body: z
      .string()
      .max(48 * 1024)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  })
  .refine(
    (value) =>
      value.operation === "fetch" ||
      (value.body === "" && value.encoding === undefined),
    "Reference discovery has no request body.",
  );
export type RepositoryRequest = z.infer<typeof repositoryRequestSchema>;
export type RepositoryTransport = (
  request: RepositoryRequest,
  signal: AbortSignal,
) => Promise<Uint8Array>;
export const maximumRepositoryTransferBytes = 64 * 1024 * 1024;
