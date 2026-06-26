import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRalphScopeEvidence,
  markRalphScopeRegistryResult,
  parseRalphScopeRegistry,
  selectRalphScopeFromRegistry,
  updateRalphScopeRegistryFromEvidence,
  type RalphScopeEvidenceDocument,
} from "./ralph-scope-registry.helper.ts";

const createEvidence = (): RalphScopeEvidenceDocument => {
  return {
    schema: "machdoch.ralph.scopeEvidence",
    schemaVersion: 1,
    generatedAt: "2026-06-25T10:00:00.000Z",
    workspaceRoot: "/workspace",
    rootPath: ".",
    excludePaths: [],
    scopes: [
      {
        id: "alpha",
        title: "Alpha",
        kind: "source-root",
        paths: ["alpha"],
        globs: ["alpha/**/*"],
        tags: ["source-root"],
        priority: 90,
        risk: "medium",
        fingerprint: "alpha-1",
        evidence: ["alpha/package.json"],
      },
      {
        id: "beta",
        title: "Beta",
        kind: "source-root",
        paths: ["beta"],
        globs: ["beta/**/*"],
        tags: ["source-root"],
        priority: 80,
        risk: "low",
        fingerprint: "beta-1",
        evidence: ["beta/package.json"],
      },
    ],
  };
};

describe("Ralph scope registry helpers", () => {
  it("discovers repository scope evidence while honoring generated/external excludes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-scope-evidence-"));

    try {
      await mkdir(join(workspace, "src"), { recursive: true });
      await mkdir(join(workspace, "src-tauri"), { recursive: true });
      await mkdir(join(workspace, "packages", "api"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "ignored"), {
        recursive: true,
      });
      await writeFile(join(workspace, "package.json"), "{}", "utf8");
      await writeFile(join(workspace, "src", "index.ts"), "", "utf8");
      await writeFile(join(workspace, "src-tauri", "Cargo.toml"), "", "utf8");
      await writeFile(join(workspace, "packages", "api", "package.json"), "{}", "utf8");

      const evidence = await discoverRalphScopeEvidence(workspace, {
        maxDepth: 3,
      });
      const scopeIds = evidence.scopes.map((scope) => scope.id);

      expect(scopeIds).toEqual(
        expect.arrayContaining([
          "repository-configuration",
          "src",
          "src-tauri",
          "packages-api",
        ]),
      );
      expect(scopeIds.join("\n")).not.toContain("node-modules");
      expect(
        evidence.scopes.find((scope) => scope.id === "src-tauri")?.risk,
      ).toBe("high");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("updates, selects, and marks scopes without repeating active scopes before the cycle completes", () => {
    const registry = parseRalphScopeRegistry(undefined, {
      flowAlias: "test-flow",
      strategy: "start-to-end",
      now: "2026-06-25T10:00:00.000Z",
    });
    const update = updateRalphScopeRegistryFromEvidence(
      registry,
      createEvidence(),
      {
        flowAlias: "test-flow",
        strategy: "start-to-end",
        now: "2026-06-25T10:01:00.000Z",
      },
    );

    expect(update.added).toEqual(["alpha", "beta"]);

    const firstSelection = selectRalphScopeFromRegistry(update.registry, {
      strategy: "start-to-end",
      now: "2026-06-25T10:02:00.000Z",
    });
    expect(firstSelection.scope?.id).toBe("alpha");

    const firstMark = markRalphScopeRegistryResult(firstSelection.registry, {
      outcome: "DONE",
      now: "2026-06-25T10:03:00.000Z",
    });
    expect(firstMark.cycleCompleted).toBe(false);

    const secondSelection = selectRalphScopeFromRegistry(firstMark.registry, {
      strategy: "start-to-end",
      now: "2026-06-25T10:04:00.000Z",
    });
    expect(secondSelection.scope?.id).toBe("beta");

    const secondMark = markRalphScopeRegistryResult(secondSelection.registry, {
      outcome: "DONE",
      now: "2026-06-25T10:05:00.000Z",
    });

    expect(secondMark.cycleCompleted).toBe(true);
    expect(secondMark.registry.selection.cycle).toBe(2);
    expect(secondMark.registry.selection.completedScopeIds).toEqual([]);
  });
});
