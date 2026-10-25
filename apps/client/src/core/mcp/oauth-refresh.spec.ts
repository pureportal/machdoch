/// <reference types="node" />
import { mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createCoordinatedOAuthFetch } from "./oauth-refresh.js";

it("coalesces refresh across connections and saves the rotated credential before releasing the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "machdoch-oauth-refresh-"));
  let tokens: OAuthTokens = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    token_type: "Bearer",
  };
  const next = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    token_type: "Bearer",
  };
  const perform = vi.fn(async () => Response.json(next));
  const adopt = vi.fn();
  const options = {
    lockPath: join(directory, "credential"),
    tokenEndpoint: () => "https://cloud.test/token",
    readTokens: async () => tokens,
    saveTokens: async (value: typeof tokens) => {
      tokens = value;
    },
    adoptTokens: adopt,
    fetch: perform,
  };
  const one = createCoordinatedOAuthFetch(options);
  const two = createCoordinatedOAuthFetch(options);
  try {
    const init = {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
      }),
    };
    const result = await Promise.all([
      one("https://cloud.test/token", init),
      two("https://cloud.test/token", init),
    ]);
    expect(
      await Promise.all(result.map((response) => response.json())),
    ).toEqual([next, next]);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(next);
    expect(adopt).toHaveBeenCalledTimes(2);
  } finally {
    await rmdir(directory);
  }
});

it("does not forward refresh credentials to a changed endpoint or retry ambiguous dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "machdoch-oauth-refresh-"));
  const perform = vi.fn(async () => {
    throw new Error("Connection lost");
  });
  const save = vi.fn();
  const request = createCoordinatedOAuthFetch({
    lockPath: join(directory, "credential"),
    tokenEndpoint: () => "https://cloud.test/token",
    readTokens: async () => ({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
    }),
    saveTokens: save,
    adoptTokens: vi.fn(),
    fetch: perform,
  });
  const init = {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "r",
    }),
  };
  try {
    await expect(request("https://evil.test/token", init)).rejects.toThrow(
      "endpoint changed",
    );
    expect(perform).not.toHaveBeenCalled();
    await expect(request("https://cloud.test/token", init)).rejects.toThrow(
      "Connection lost",
    );
    expect(perform).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  } finally {
    await rmdir(directory);
  }
});
