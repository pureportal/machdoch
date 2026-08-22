import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRalphGenerationArtifactPaths,
  createRalphGenerationLogger,
  formatRalphGenerationMarkdownEntry,
  getRalphGenerationDirectory,
} from "./create-ralph-generation-logger.helper.ts";

describe("getRalphGenerationDirectory", () => {
  it("resolves workspace generation artifacts under the Ralph storage directory", () => {
    expect(getRalphGenerationDirectory("/workspace")).toBe(
      join("/workspace", ".machdoch", "ralph", "generations"),
    );
  });
});

describe("createRalphGenerationArtifactPaths", () => {
  it("uses normalized preferred ids and appends suffixes for existing directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-generation-paths-"));

    try {
      await createRalphGenerationLogger(directory, {
        runId: "Run With Spaces",
        flowPath: "/flows/flow.json",
        generationFlowPath: "/flows/.flow-generation.json",
        prompt: "Create a flow.",
      });

      const paths = createRalphGenerationArtifactPaths(
        getRalphGenerationDirectory(directory),
        "2026-06-20T10:11:12.013Z",
        "Run With Spaces",
      );

      expect(paths.id).toBe("Run-With-Spaces-1");
      expect(paths.recordPath).toBe(join(paths.directory, "generation.json"));
      expect(paths.simpleMarkdownPath).toBe(join(paths.directory, "simple.md"));
      expect(paths.traceJsonlPath).toBe(join(paths.directory, "trace.jsonl"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to timestamp-safe ids when no preferred id is provided", () => {
    const paths = createRalphGenerationArtifactPaths(
      "/generations",
      "2026-06-20T10:11:12.013Z",
    );

    expect(paths.id).toBe("2026-06-20T10-11-12-013Z");
  });
});

describe("formatRalphGenerationMarkdownEntry", () => {
  it("includes optional round, actor, and block counts", () => {
    expect(
      formatRalphGenerationMarkdownEntry({
        type: "validator-result",
        generationRunId: "generation-1",
        createdAt: "2026-06-20T10:11:12.013Z",
        message: "Validated.",
        round: 2,
        actor: "validator",
        blockCount: 4,
        edgeCount: 3,
      }),
    ).toBe(
      "- 2026-06-20T10:11:12.013Z round 2 validator Validated. (4 blocks, 3 edges)",
    );
  });
});

describe("createRalphGenerationLogger", () => {
  it("writes bounded markdown and JSONL generation logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-generation-logger-"));

    try {
      const logger = await createRalphGenerationLogger(directory, {
        runId: "generation-1",
        flowPath: "/flows/flow.json",
        generationFlowPath: "/flows/.flow-generation.json",
        prompt: "Create a deploy flow.",
      });

      logger.event({
        type: "started",
        generationRunId: "generation-1",
        createdAt: "2026-06-20T10:11:12.013Z",
        message: "Started.",
      });
      await logger.flush();

      await expect(readFile(logger.paths.simpleMarkdownPath, "utf8")).resolves.toContain(
        "- 2026-06-20T10:11:12.013Z Started.",
      );
      await expect(readFile(logger.paths.traceJsonlPath, "utf8")).resolves.toContain(
        "\"type\":\"started\"",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
