import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../../core/types.ts";
import {
  createCliStartupSummaryLines,
  loadDesktopShellSummary,
  resolveDesktopShellStatePath,
} from "./cli-startup-summary.ts";

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";

const workspacesToClean: string[] = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "machdoch-cli-startup-"));
  workspacesToClean.push(directory);

  return directory;
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createConfig = (
  overrides: Partial<
    Pick<
      RuntimeConfig,
      "mode" | "provider" | "providerAvailability" | "webSearch"
    >
  > = {},
): Pick<
  RuntimeConfig,
  "mode" | "provider" | "providerAvailability" | "webSearch"
> => ({
  mode: "machdoch",
  provider: "openai",
  providerAvailability: [
    { provider: "openai", configured: true },
    { provider: "anthropic", configured: false },
    { provider: "google", configured: true },
  ],
  webSearch: {
    activeProvider: "serper",
    providerAvailability: [
      { provider: "perplexity", configured: false },
      { provider: "tavily", configured: true },
      { provider: "serper", configured: true },
    ],
  },
  ...overrides,
});

describe("resolveDesktopShellStatePath", () => {
  it("resolves the desktop store under the Tauri app-data directory", () => {
    const path = resolveDesktopShellStatePath({
      env: {},
      platform: "linux",
      homeDirectory: "/home/user",
    });

    expect(path).toBe(
      join(
        "/home/user",
        ".local",
        "share",
        "com.machdoch.desktop",
        "machdoch-shell-state.json",
      ),
    );
  });
});

describe("loadDesktopShellSummary", () => {
  it("returns missing when the desktop store file is absent", async () => {
    const directory = await createTempDirectory();
    const storePath = join(directory, "missing.json");

    await expect(loadDesktopShellSummary({ storePath })).resolves.toEqual({
      status: "missing",
      storePath,
    });
  });

  it("loads open desktop sessions and marks the current active session", async () => {
    const directory = await createTempDirectory();
    const storePath = join(directory, "machdoch-shell-state.json");

    await writeFile(
      storePath,
      JSON.stringify(
        {
          [SHELL_STATE_STORAGE_KEY]: {
            activeSessionId: "running-session",
            sessions: [
              {
                id: "done-session",
                createdAt: 100,
                updatedAt: 150,
                workspace: "C:/Development/machdoch",
                provider: "openai",
                model: "gpt-5.5",
                mode: "ask",
                messages: [
                  {
                    id: "done-task",
                    role: "user",
                    content: "Review auth flow",
                    createdAt: 110,
                  },
                  {
                    id: "done-answer",
                    taskId: "done-task",
                    role: "agent",
                    content: "Done",
                    createdAt: 120,
                    source: {
                      kind: "execution",
                      execution: {
                        status: "executed",
                      },
                    },
                  },
                ],
              },
              {
                id: "running-session",
                createdAt: 200,
                updatedAt: 250,
                workspace: "C:/Development/machdoch",
                provider: "anthropic",
                model: "claude-sonnet-4-6",
                messages: [
                  {
                    id: "running-task",
                    role: "user",
                    content: "Investigate flaky tests",
                    createdAt: 210,
                  },
                ],
              },
              {
                id: "archived-session",
                createdAt: 300,
                updatedAt: 350,
                archivedAt: 400,
                workspace: null,
                provider: "google",
                model: "gemini-2.5-flash",
                messages: [],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const summary = await loadDesktopShellSummary({ storePath });

    expect(summary).toMatchObject({
      status: "loaded",
      activeSessionId: "running-session",
      archivedSessionCount: 1,
      totalSessionCount: 3,
    });

    if (summary.status !== "loaded") {
      throw new Error("Expected loaded desktop shell summary.");
    }

    expect(summary.activeSessions.map((session) => session.title)).toEqual([
      "Investigate flaky tests",
      "Review auth flow",
    ]);
    expect(summary.activeSessions[0]).toMatchObject({
      active: true,
      status: "running",
    });
    expect(summary.activeSessions[1]).toMatchObject({
      active: false,
      status: "done",
    });
  });
});

describe("createCliStartupSummaryLines", () => {
  it("prints active sessions plus model and web-search provider availability", () => {
    const lines = createCliStartupSummaryLines(createConfig(), {
      status: "loaded",
      activeSessionId: "running-session",
      activeSessions: [
        {
          id: "running-session",
          title: "Investigate flaky tests",
          active: true,
          archived: false,
          status: "running",
          workspace: "C:/Development/machdoch",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          updatedAt: 250,
        },
        {
          id: "done-session",
          title: "Review auth flow",
          active: false,
          archived: false,
          status: "done",
          workspace: "C:/Development/machdoch",
          provider: "openai",
          model: "gpt-5.5",
          mode: "ask",
          updatedAt: 150,
        },
      ],
      archivedSessionCount: 1,
      totalSessionCount: 3,
    });

    expect(lines).toEqual([
      "active sessions: 2 open (3 total, 1 archived)",
      "  - Investigate flaky tests [current, running] Anthropic / claude-sonnet-4-6 / machdoch / machdoch",
      "  - Review auth flow [done] OpenAI / gpt-5.5 / ask / machdoch",
      "providers:",
      "  model providers: OpenAI available (active), Anthropic not configured, Google available",
      "  web search providers: Perplexity not configured, Tavily available, Serper available (active)",
    ]);
  });

  it("keeps provider output useful when no desktop state exists", () => {
    const lines = createCliStartupSummaryLines(createConfig(), {
      status: "missing",
      storePath: "/missing/machdoch-shell-state.json",
    });

    expect(lines).toEqual([
      "active sessions: no desktop state found",
      "providers:",
      "  model providers: OpenAI available (active), Anthropic not configured, Google available",
      "  web search providers: Perplexity not configured, Tavily available, Serper available (active)",
    ]);
  });
});
