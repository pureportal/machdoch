import type { z } from "zod";
import {
  gitProviderLabels,
  type GitProvider,
} from "../../../lib/git-providers";
import { CloudError } from "../access";

const requestTimeoutMs = 15_000;

export interface GitRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function failure(provider: GitProvider, status: number, payload: unknown) {
  const label = gitProviderLabels[provider];
  const message =
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string"
      ? payload.message.slice(0, 300)
      : payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
        ? payload.error.slice(0, 300)
        : `${label} answered with ${status}.`;
  return new CloudError(
    [401, 403, 422].includes(status)
      ? 422
      : status === 404
        ? 404
        : status === 405 || status === 409
          ? 409
          : 502,
    status === 401 ? "git_token" : "git_request",
    status === 401
      ? `${label} rejected the token. Enter a valid token.`
      : message,
  );
}

export async function gitRequest<T>(
  provider: GitProvider,
  transport: typeof fetch,
  url: string,
  schema: z.ZodType<T>,
  init: GitRequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await transport(url, {
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        "User-Agent": "machdoch-cloud",
        ...init.headers,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new CloudError(
      502,
      "git_unreachable",
      `${gitProviderLabels[provider]} is unreachable. Check the API address and try again.`,
    );
  }
  const payload: unknown =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw failure(provider, response.status, payload);
  return schema.parse(payload);
}
