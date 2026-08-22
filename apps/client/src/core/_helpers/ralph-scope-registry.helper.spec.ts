import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRalphScopeEvidence,
  isCompletedRalphScopeOutcome,
  markRalphScopeRegistryResult,
  parseRalphScopeRegistry,
  selectRalphScopeFromRegistry,
  updateRalphScopeRegistryFromEvidence,
  type RalphScopeEvidenceDocument,
} from "./ralph-scope-registry.helper.ts";

const createEvidence = (): RalphScopeEvidenceDocument => {
  return {
    schema: "machdoch.ralph.scopeEvidence",
    schemaVersion: 2,
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
      await mkdir(join(workspace, "engine", "payments"), { recursive: true });
      await mkdir(join(workspace, "acceptance"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "ignored"), {
        recursive: true,
      });
      await mkdir(
        join(workspace, "packages", "api", "coverage", "modules", "ignored"),
        { recursive: true },
      );
      await mkdir(
        join(workspace, "packages", "api", "node_modules", "ignored"),
        { recursive: true },
      );
      await writeFile(join(workspace, "package.json"), "{}", "utf8");
      await writeFile(join(workspace, "src", "index.ts"), "", "utf8");
      await writeFile(join(workspace, "src-tauri", "Cargo.toml"), "", "utf8");
      await writeFile(
        join(workspace, "packages", "api", "package.json"),
        "{}",
        "utf8",
      );
      await writeFile(
        join(workspace, "engine", "payments", "index.ts"),
        "",
        "utf8",
      );
      await writeFile(
        join(workspace, "engine", "payments", "charge.ts"),
        "",
        "utf8",
      );
      await writeFile(
        join(workspace, "engine", "payments", "refund.ts"),
        "",
        "utf8",
      );
      await writeFile(
        join(workspace, "acceptance", "checkout.test.ts"),
        "",
        "utf8",
      );
      await writeFile(
        join(workspace, "acceptance", "refund.test.ts"),
        "",
        "utf8",
      );
      await writeFile(
        join(
          workspace,
          "packages",
          "api",
          "coverage",
          "modules",
          "ignored",
          "package.json",
        ),
        "{}",
        "utf8",
      );
      await writeFile(
        join(
          workspace,
          "packages",
          "api",
          "node_modules",
          "ignored",
          "package.json",
        ),
        "{}",
        "utf8",
      );

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
          "engine-payments",
          "acceptance",
        ]),
      );
      expect(scopeIds.join("\n")).not.toContain("node-modules");
      expect(scopeIds.join("\n")).not.toContain("coverage");
      expect(
        evidence.scopes.find((scope) => scope.id === "src-tauri")?.risk,
      ).toBe("high");
      expect(
        evidence.scopes.find((scope) => scope.id === "engine-payments"),
      ).toMatchObject({
        kind: "module",
        risk: "medium",
        tags: expect.arrayContaining([
          "entrypoint",
          "missing-local-tests",
          "source-bearing",
        ]),
        evidence: expect.arrayContaining([
          "semantic:entrypoints=index.ts",
          "semantic:source-files=3",
          "semantic:test-files=0",
        ]),
      });
      expect(
        evidence.scopes.find((scope) => scope.id === "acceptance"),
      ).toMatchObject({
        kind: "test",
        tags: expect.arrayContaining(["test-covered"]),
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects malformed routing and verdict state without reading prose", () => {
    const registry = updateRalphScopeRegistryFromEvidence(
      parseRalphScopeRegistry(undefined, {
        flowAlias: "test-flow",
        strategy: "risk-first",
        now: "2026-06-25T10:00:00.000Z",
      }),
      createEvidence(),
      {
        flowAlias: "test-flow",
        strategy: "risk-first",
        now: "2026-06-25T10:01:00.000Z",
      },
    ).registry;
    const firstScope = registry.scopes[0]!;

    expect(isCompletedRalphScopeOutcome("completed")).toBe(true);
    expect(isCompletedRalphScopeOutcome("deferred")).toBe(false);
    expect(
      isCompletedRalphScopeOutcome(
        'completed because the model said "DONE"' as never,
      ),
    ).toBe(false);
    expect(() =>
      markRalphScopeRegistryResult(registry, {
        outcome: "DONE_AFTER_REVIEW" as never,
      }),
    ).toThrow("Expected a valid Ralph scope outcome.");
    expect(() =>
      parseRalphScopeRegistry(
        {
          ...registry,
          selection: { ...registry.selection, strategy: "RISK-FIRST" },
        },
        { flowAlias: "test-flow", strategy: "risk-first" },
      ),
    ).toThrow("Expected a valid Ralph scope selection strategy.");
    expect(() =>
      parseRalphScopeRegistry(
        { ...registry, schemaVersion: 3 },
        { flowAlias: "test-flow", strategy: "risk-first" },
      ),
    ).toThrow("Expected a supported Ralph scope registry schema.");
    expect(() =>
      parseRalphScopeRegistry(
        {
          ...registry,
          scopes: [
            {
              ...firstScope,
              risk: "high because auth token appears in the path",
            },
          ],
        },
        { flowAlias: "test-flow", strategy: "risk-first" },
      ),
    ).toThrow("Expected Ralph scope risk");
    expect(() =>
      parseRalphScopeRegistry(
        {
          ...registry,
          scopes: [{ ...firstScope, lastOutcome: "DONE" }],
        },
        { flowAlias: "test-flow", strategy: "risk-first" },
      ),
    ).toThrow("Expected a valid persisted Ralph scope outcome.");
  });

  it("migrates version 1 registries without losing selection or outcome state", () => {
    const registry = updateRalphScopeRegistryFromEvidence(
      parseRalphScopeRegistry(undefined, {
        flowAlias: "test-flow",
        strategy: "round-robin",
        now: "2026-06-25T10:00:00.000Z",
      }),
      createEvidence(),
      {
        flowAlias: "test-flow",
        strategy: "round-robin",
        now: "2026-06-25T10:01:00.000Z",
      },
    ).registry;
    const legacyRegistry = {
      ...registry,
      schemaVersion: 1,
      selection: {
        ...registry.selection,
        cursor: 1,
        cycle: 4,
        currentScopeId: "alpha",
        completedScopeIds: ["beta"],
      },
      scopes: registry.scopes.map((scope) => ({
        ...scope,
        lastOutcome:
          scope.id === "alpha" ? "DONE" : "DEFERRED_AFTER_BOUNDED_REPAIR",
      })),
      history: [
        {
          at: "2026-06-25T09:00:00.000Z",
          type: "scope-marked",
          scopeId: "alpha",
          outcome: "STOP_NO_MEANINGFUL_WORK",
        },
        {
          at: "2026-06-25T09:10:00.000Z",
          type: "scope-marked",
          scopeId: "alpha",
          outcome: "INVALID_OUTPUT",
        },
        {
          at: "2026-06-25T09:20:00.000Z",
          type: "scope-marked",
          scopeId: "alpha",
          outcome: "WAITING_FOR_EXTERNAL_STATE",
        },
        {
          at: "2026-06-25T09:30:00.000Z",
          type: "scope-marked",
          scopeId: "alpha",
          outcome: "CUSTOM_FAILURE",
        },
      ],
    };

    const migrated = parseRalphScopeRegistry(legacyRegistry, {
      flowAlias: "test-flow",
      strategy: "priority",
      now: "2026-06-25T11:00:00.000Z",
    });

    expect(migrated).toMatchObject({
      schema: "machdoch.ralph.scopeRegistry",
      schemaVersion: 2,
      selection: {
        strategy: "round-robin",
        cursor: 1,
        cycle: 4,
        currentScopeId: "alpha",
        completedScopeIds: ["beta"],
      },
    });
    expect(
      Object.fromEntries(
        migrated.scopes.map((scope) => [scope.id, scope.lastOutcome]),
      ),
    ).toEqual({ alpha: "completed", beta: "deferred" });
    expect(migrated.history.map((entry) => entry.outcome)).toEqual([
      "no-meaningful-work",
      "invalid",
      "external-state",
      "failed",
    ]);
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
      outcome: "completed",
      now: "2026-06-25T10:03:00.000Z",
    });
    expect(firstMark.cycleCompleted).toBe(false);
    expect(firstMark.scope?.id).toBe("alpha");
    expect(firstMark.scope?.validatedCount).toBe(1);
    expect(firstMark.registry.selection.currentScopeId).toBeNull();
    expect(firstMark.registry.selection.completedScopeIds).toEqual(["alpha"]);

    const secondSelection = selectRalphScopeFromRegistry(firstMark.registry, {
      strategy: "start-to-end",
      now: "2026-06-25T10:04:00.000Z",
    });
    expect(secondSelection.scope?.id).toBe("beta");
    expect(secondSelection.reusedCurrentScope).toBe(false);

    const secondMark = markRalphScopeRegistryResult(secondSelection.registry, {
      outcome: "completed",
      now: "2026-06-25T10:05:00.000Z",
    });

    expect(secondMark.cycleCompleted).toBe(true);
    expect(secondMark.registry.selection.cycle).toBe(2);
    expect(secondMark.registry.selection.completedScopeIds).toEqual([]);
  });

  it("cools down deferred scopes without counting them as validated or completed", () => {
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
    const firstSelection = selectRalphScopeFromRegistry(update.registry, {
      now: "2026-06-25T10:02:00.000Z",
    });
    const deferred = markRalphScopeRegistryResult(firstSelection.registry, {
      outcome: "deferred",
      now: "2026-06-25T10:03:00.000Z",
    });

    expect(deferred.scope).toMatchObject({
      id: "alpha",
      validatedCount: 0,
      lastValidatedAt: null,
      lastOutcome: "deferred",
      lastOutcomeAt: "2026-06-25T10:03:00.000Z",
      eligibleAfter: "2026-06-25T10:33:00.000Z",
    });
    expect(deferred.cycleCompleted).toBe(false);
    expect(deferred.registry.selection.completedScopeIds).toEqual([]);
    expect(deferred.registry.history.at(-1)).toMatchObject({
      type: "scope-marked",
      outcome: "deferred",
      eligibleAfter: "2026-06-25T10:33:00.000Z",
    });

    const nextSelection = selectRalphScopeFromRegistry(deferred.registry, {
      now: "2026-06-25T10:04:00.000Z",
    });
    expect(nextSelection.scope?.id).toBe("beta");

    const betaCompleted = markRalphScopeRegistryResult(nextSelection.registry, {
      outcome: "completed",
      now: "2026-06-25T10:05:00.000Z",
    });
    const noEligibleWork = selectRalphScopeFromRegistry(
      betaCompleted.registry,
      {
        now: "2026-06-25T10:06:00.000Z",
      },
    );
    expect(noEligibleWork.scope).toBeUndefined();

    const retrySelection = selectRalphScopeFromRegistry(
      noEligibleWork.registry,
      { now: "2026-06-25T10:34:00.000Z" },
    );
    expect(retrySelection.scope?.id).toBe("alpha");
    expect(retrySelection.scope?.eligibleAfter).toBeNull();
  });

  it("uses a long cooldown for no-meaningful-work outcomes", () => {
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
    const selection = selectRalphScopeFromRegistry(update.registry, {
      now: "2026-06-25T10:02:00.000Z",
    });
    const stopped = markRalphScopeRegistryResult(selection.registry, {
      outcome: "no-meaningful-work",
      now: "2026-06-25T10:03:00.000Z",
    });

    expect(stopped.scope?.eligibleAfter).toBe("2026-06-26T10:03:00.000Z");
    expect(stopped.scope?.validatedCount).toBe(0);
    expect(stopped.registry.selection.completedScopeIds).toEqual([]);
  });

  it("advances a lifie-style completed UI scope only after it is marked", () => {
    const registry = parseRalphScopeRegistry(
      {
        schema: "machdoch.ralph.scopeRegistry",
        schemaVersion: 2,
        flowAlias: "autonomous-ui-improvement-loop",
        selection: {
          strategy: "round-robin",
          cursor: 1,
          cycle: 1,
          currentScopeId: "api",
          completedScopeIds: [],
        },
        scopes: [
          {
            id: "api",
            title: "Api",
            kind: "package",
            status: "active",
            paths: ["api"],
            globs: ["api/**/*"],
            tags: ["api", "package"],
            priority: 92,
            risk: "high",
            fingerprint: "api-1",
            evidence: ["api/package.json"],
            selectedCount: 1,
            validatedCount: 0,
          },
          {
            id: "app",
            title: "App",
            kind: "package",
            status: "active",
            paths: ["app"],
            globs: ["app/**/*"],
            tags: ["app", "package"],
            priority: 90,
            risk: "medium",
            fingerprint: "app-1",
            evidence: ["app/package.json"],
            selectedCount: 0,
            validatedCount: 0,
          },
        ],
      },
      {
        flowAlias: "autonomous-ui-improvement-loop",
        strategy: "round-robin",
        now: "2026-07-03T05:00:00.000Z",
      },
    );

    const reusedSelection = selectRalphScopeFromRegistry(registry, {
      strategy: "round-robin",
      now: "2026-07-03T05:01:00.000Z",
    });

    expect(reusedSelection.scope?.id).toBe("api");
    expect(reusedSelection.reusedCurrentScope).toBe(true);

    const mark = markRalphScopeRegistryResult(registry, {
      outcome: "completed",
      now: "2026-07-03T05:02:00.000Z",
    });

    expect(mark.cycleCompleted).toBe(false);
    expect(mark.scope?.id).toBe("api");
    expect(mark.scope?.validatedCount).toBe(1);
    expect(mark.registry.selection.currentScopeId).toBeNull();
    expect(mark.registry.selection.completedScopeIds).toEqual(["api"]);
    expect(mark.registry.history.at(-1)).toMatchObject({
      type: "scope-marked",
      scopeId: "api",
      outcome: "completed",
    });

    const nextSelection = selectRalphScopeFromRegistry(mark.registry, {
      strategy: "round-robin",
      now: "2026-07-03T05:03:00.000Z",
    });

    expect(nextSelection.scope?.id).toBe("app");
    expect(nextSelection.reusedCurrentScope).toBe(false);
  });

  it("prioritizes UI-heavy scopes before generic API scopes with ui-first", () => {
    const registry = parseRalphScopeRegistry(
      {
        schema: "machdoch.ralph.scopeRegistry",
        schemaVersion: 2,
        flowAlias: "autonomous-ui-improvement-loop",
        selection: {
          strategy: "ui-first",
          cursor: 0,
          cycle: 1,
          currentScopeId: null,
          completedScopeIds: [],
        },
        scopes: [
          {
            id: "api",
            title: "Api",
            kind: "package",
            status: "active",
            paths: ["api"],
            tags: ["api", "package"],
            priority: 92,
            risk: "high",
            evidence: ["api/package.json"],
          },
          {
            id: "app",
            title: "App",
            kind: "package",
            status: "active",
            paths: ["app"],
            tags: ["app", "package"],
            priority: 72,
            risk: "low",
            evidence: ["app/src/App.tsx"],
          },
          {
            id: "app-src-components",
            title: "Components",
            kind: "source-root",
            status: "active",
            paths: ["app/src/components"],
            tags: ["app", "components", "source-root"],
            priority: 70,
            risk: "low",
            evidence: ["app/src/components/Button.tsx"],
          },
        ],
      },
      {
        flowAlias: "autonomous-ui-improvement-loop",
        strategy: "ui-first",
        now: "2026-07-03T06:00:00.000Z",
      },
    );

    const selection = selectRalphScopeFromRegistry(registry, {
      strategy: "ui-first",
      now: "2026-07-03T06:01:00.000Z",
    });

    expect(selection.scope?.id).toBe("app-src-components");

    const mark = markRalphScopeRegistryResult(selection.registry, {
      outcome: "completed",
      now: "2026-07-03T06:02:00.000Z",
    });
    const nextSelection = selectRalphScopeFromRegistry(mark.registry, {
      strategy: "ui-first",
      now: "2026-07-03T06:03:00.000Z",
    });

    expect(nextSelection.scope?.id).toBe("app");
    expect(nextSelection.reusedCurrentScope).toBe(false);
  });

  it("returns a controlled dependency-aware cluster with related tests and config", () => {
    const registry = parseRalphScopeRegistry(
      {
        schema: "machdoch.ralph.scopeRegistry",
        schemaVersion: 2,
        flowAlias: "autonomous-code-improvement-loop",
        selection: {
          strategy: "start-to-end",
          cursor: 0,
          cycle: 1,
          currentScopeId: null,
          completedScopeIds: [],
        },
        scopes: [
          {
            id: "app-src",
            title: "App Source",
            kind: "source-root",
            status: "active",
            paths: ["app/src"],
            globs: ["app/src/**/*"],
            tags: ["app", "source-root"],
            priority: 90,
            risk: "high",
            evidence: ["app/src/index.ts"],
          },
          {
            id: "app-tests",
            title: "App Tests",
            kind: "test",
            status: "active",
            paths: ["app/tests"],
            globs: ["app/tests/**/*"],
            tags: ["app", "test"],
            priority: 40,
            risk: "low",
            evidence: ["app/tests/index.spec.ts"],
          },
          {
            id: "repository-configuration",
            title: "Repository Configuration",
            kind: "config",
            status: "active",
            paths: ["package.json", "tsconfig.json"],
            globs: ["package.json", "tsconfig.json"],
            tags: ["config", "workspace"],
            priority: 35,
            risk: "medium",
            evidence: ["package.json"],
          },
        ],
      },
      {
        flowAlias: "autonomous-code-improvement-loop",
        strategy: "start-to-end",
        now: "2026-07-03T07:00:00.000Z",
      },
    );

    const selection = selectRalphScopeFromRegistry(registry, {
      strategy: "start-to-end",
      now: "2026-07-03T07:01:00.000Z",
    });

    expect(selection.scope?.id).toBe("app-src");
    expect(selection.scopeCluster).toMatchObject({
      rootScopeId: "app-src",
      risk: "high",
    });
    expect(selection.scopeCluster?.scopeIds).toEqual([
      "app-src",
      "app-tests",
      "repository-configuration",
    ]);
    expect(selection.scopeCluster?.paths).toEqual(
      expect.arrayContaining(["app/src", "app/tests", "package.json"]),
    );
    expect(selection.scopeCluster?.rationale.join("\n")).toContain(
      "adjacent tests",
    );
    expect(selection.scopeCluster?.rationale.join("\n")).toContain(
      "shared project configuration",
    );
  });
});
