import { z } from "zod";

const repositorySegment = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function isGitRepositoryUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const segments = url.pathname.slice(1).split("/");
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.href === value &&
    segments.length >= 2 &&
    segments.length <= 20 &&
    segments.every((segment) => repositorySegment.test(segment))
  );
}

export const gitRepositoryUrlSchema = z
  .string()
  .max(500)
  .refine(
    isGitRepositoryUrl,
    "Use an HTTPS repository URL such as https://github.com/owner/name, without credentials, query, or fragment.",
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
