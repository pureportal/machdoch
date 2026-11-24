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

async function tail(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  let kept = new Uint8Array(0);
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const merged = new Uint8Array(kept.length + chunk.length);
    merged.set(kept);
    merged.set(chunk, kept.length);
    kept = merged.length > limit ? merged.slice(merged.length - limit) : merged;
  }
  return new TextDecoder().decode(kept);
}

export async function gitTextTail(
  provider: GitProvider,
  transport: typeof fetch,
  url: string,
  headers: Record<string, string>,
  limit: number,
): Promise<string> {
  const send = (target: string, authorized: boolean) =>
    transport(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: authorized
        ? { "User-Agent": "machdoch-cloud", ...headers }
        : { "User-Agent": "machdoch-cloud" },
    });
  let response: Response;
  try {
    response = await send(url, true);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const target = new URL(location, url);
      if (target.protocol !== "https:" && target.origin !== new URL(url).origin)
        throw new CloudError(
          502,
          "git_request",
          `${gitProviderLabels[provider]} redirected the log to an insecure address.`,
        );
      response = await send(target.href, target.origin === new URL(url).origin);
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError(
      502,
      "git_unreachable",
      `${gitProviderLabels[provider]} is unreachable. Check the API address and try again.`,
    );
  }
  if (!response.ok)
    throw failure(
      provider,
      response.status,
      await response.json().catch(() => null),
    );
  return tail(response, limit);
}

export function absentAsNull(error: unknown): null {
  if (error instanceof CloudError && error.status === 404) return null;
  throw error;
}
