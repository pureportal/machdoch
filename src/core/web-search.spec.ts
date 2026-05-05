/// <reference types="vitest/globals" />

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWebSearch } from "./web-search.ts";

const workspacesToClean: string[] = [];
const originalEnvironment = new Map<string, string | undefined>();
const ISOLATED_ENV_KEYS = [
  "SERPER_API_KEY",
  "MACHDOCH_USER_CONFIG_DIR",
] as const;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-search-"));
  workspacesToClean.push(workspaceRoot);
  process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
  return workspaceRoot;
};

const isolateEnvironment = (): void => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (!originalEnvironment.has(key)) {
      originalEnvironment.set(key, process.env[key]);
    }

    delete process.env[key];
  }
};

const restoreEnvironment = (): void => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  originalEnvironment.clear();
};

afterEach(async () => {
  vi.unstubAllGlobals();
  restoreEnvironment();

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("executeWebSearch", () => {
  it("runs Serper searches and normalizes organic result snippets", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();
    process.env.SERPER_API_KEY = "serper-test-key-1234567890";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          answerBox: {
            answer: "Serper returned a direct answer.",
          },
          organic: [
            {
              title: "Serper API docs",
              link: "https://serper.dev/",
              snippet: "Google Search API results.",
              date: "May 5, 2026",
            },
            {
              title: "",
              link: "https://example.invalid/missing-title",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = await executeWebSearch(
      workspaceRoot,
      "serper",
      "  Serper API documentation  ",
      3,
    );

    expect(result).toEqual({
      provider: "serper",
      query: "Serper API documentation",
      summary: "Serper returned a direct answer.",
      results: [
        {
          title: "Serper API docs",
          url: "https://serper.dev/",
          snippet: "Google Search API results.",
          date: "May 5, 2026",
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://google.serper.dev/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          "X-API-KEY": "serper-test-key-1234567890",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: "Serper API documentation",
          num: 3,
        }),
      }),
    );
  });

  it("rejects Serper searches when no API key is configured", async () => {
    isolateEnvironment();
    const workspaceRoot = await createWorkspace();

    await expect(
      executeWebSearch(workspaceRoot, "serper", "current docs"),
    ).rejects.toThrow("Serper web search is not configured");
  });
});
