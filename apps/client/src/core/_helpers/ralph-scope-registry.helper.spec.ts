import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessRalphScopeRegistryAvailability,
  beginRalphScopeRegistryCycle,
  discoverRalphScopeEvidence,
  isCompletedRalphScopeOutcome,
  isRalphScopeCoverageTerminalOutcome,
  markRalphScopeRegistryResult,
  parseRalphScopeRegistry,
  selectRalphScopeFromRegistry,
  updateRalphScopeRegistryFromEvidence,
  type RalphScopeEvidenceDocument,
} from "./ralph-scope-registry.helper.ts";

const createEvidence = (): RalphScopeEvidenceDocument => {
  return {
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
  it("excludes Python caches at every depth and when scanned explicitly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-python-caches-"));
    const cachePaths = [
      "__pycache__",
      "apps/client/src-tauri/python/__pycache__",
      "apps/client/src-tauri/python/model/__pycache__",
    ];
    const sourcePaths = [
      "apps/client/src-tauri/python/model",
      "apps/client/src-tauri/python/__pycache__-tools",
      "apps/client/src-tauri/python/pycache",
    ];

    try {
      for (const path of sourcePaths) {
        const directory = join(workspace, path);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "__init__.py"), "", "utf8");
      }
      for (const path of cachePaths) {
        const directory = join(workspace, path);
        await mkdir(join(directory, "tests"), { recursive: true });
        await writeFile(join(directory, "test_model.cpython-313.pyc"), "");
        await writeFile(join(directory, "test_trainer.cpython-313.pyc"), "");
        await writeFile(join(directory, "tests", "test_model.py"), "", "utf8");
      }

      for (const excludePaths of [undefined, []]) {
        const evidence = await discoverRalphScopeEvidence(workspace, {
          ...(excludePaths === undefined ? {} : { excludePaths }),
          maxDepth: 9,
        });
        expect(evidence.excludePaths).toContain("__pycache__");
        expect(evidence.scopes.flatMap((scope) => scope.paths)).toEqual(
          expect.arrayContaining(sourcePaths),
        );
        expect(
          evidence.scopes.some((scope) =>
            scope.paths.some((path) => path.split("/").includes("__pycache__")),
          ),
        ).toBe(false);
      }

      for (const rootPath of cachePaths) {
        const evidence = await discoverRalphScopeEvidence(workspace, {
          rootPath,
          excludePaths: [],
          maxDepth: 2,
        });
        expect(evidence.scopes).toEqual([]);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("requires source files for Python test-directory evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-python-tests-"));
    const filesByDirectory = {
      bytecode: ["test_model.cpython-313.pyc", "test_trainer.pyc"],
      mixed: ["test_model.py", "test_trainer.pyc"],
      acceptance: ["test_model.py", "test_trainer.py", "test_model.pyc"],
      model: ["__init__.py", "model.py", "trainer.py", "test_model.pyc"],
    };

    try {
      for (const [path, files] of Object.entries(filesByDirectory)) {
        const directory = join(workspace, path);
        await mkdir(directory, { recursive: true });
        for (const file of files) {
          await writeFile(join(directory, file), "", "utf8");
        }
      }

      const evidence = await discoverRalphScopeEvidence(workspace);
      expect(evidence.scopes.map((scope) => scope.id)).not.toContain(
        "bytecode",
      );
      expect(evidence.scopes.map((scope) => scope.id)).not.toContain("mixed");
      expect(
        evidence.scopes.find((scope) => scope.id === "acceptance"),
      ).toMatchObject({
        kind: "test",
        tags: expect.arrayContaining(["test-covered"]),
        evidence: expect.arrayContaining([
          "semantic:source-files=0",
          "semantic:test-files=2",
        ]),
      });
      expect(
        evidence.scopes.find((scope) => scope.id === "model"),
      ).toMatchObject({
        kind: "module",
        tags: expect.arrayContaining(["source-bearing", "missing-local-tests"]),
        evidence: expect.arrayContaining([
          "semantic:source-files=3",
          "semantic:test-files=0",
        ]),
      });
      expect(
        evidence.scopes
          .flatMap((scope) => scope.evidence)
          .some((path) => path.endsWith(".pyc")),
      ).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("retires persisted Python cache scopes without losing their history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-persisted-caches-"));
    const sourcePath = "apps/client/src-tauri/python/model";
    const cachePaths = [
      "__pycache__",
      "apps/client/src-tauri/python/__pycache__",
      "apps\\client\\src-tauri\\python\\__pycache__\\tests",
    ];
    const now = "2026-06-25T10:00:00.000Z";
    const options = {
      flowAlias: "test-flow",
      strategy: "priority" as const,
      now,
    };
    const registered = updateRalphScopeRegistryFromEvidence(
      parseRalphScopeRegistry(undefined, options),
      createEvidence(),
      options,
    ).registry;
    const sourceScope = {
      ...registered.scopes[0]!,
      paths: [sourcePath],
      globs: [`${sourcePath}/**/*`],
    };
    const cacheScopes = cachePaths.map((path, index) => ({
      ...sourceScope,
      id: `python-cache-${index}`,
      kind: "test" as const,
      paths: [path],
      globs: [`${path}/**/*`],
      priority: 100,
      selectedCount: 3,
      lastSelectedAt: now,
    }));
    const staleRegistry = {
      ...registered,
      scopes: [sourceScope, ...cacheScopes],
      selection: {
        ...registered.selection,
        currentScopeId: cacheScopes[0]!.id,
        completedScopeIds: [cacheScopes[1]!.id],
      },
      history: [
        {
          at: now,
          type: "scope-selected" as const,
          scopeId: cacheScopes[0]!.id,
        },
      ],
    };

    try {
      const registryPath = join(workspace, "scope-registry.json");
      await writeFile(registryPath, JSON.stringify(staleRegistry), "utf8");
      const persisted = parseRalphScopeRegistry(
        JSON.parse(await readFile(registryPath, "utf8")),
        options,
      );
      expect(persisted.selection.currentScopeId).toBeNull();
      expect(persisted.selection.completedScopeIds).toEqual([]);

      for (const registry of [persisted, staleRegistry]) {
        for (const forceNew of [false, true]) {
          const selection = selectRalphScopeFromRegistry(registry, {
            now,
            forceNew,
          });
          expect(selection.scope?.id).toBe(sourceScope.id);
          expect(selection.reusedCurrentScope).toBe(false);
          expect(selection.registry.selection.currentScopeId).toBe(
            sourceScope.id,
          );
          expect(selection.scopeCluster?.scopeIds).toEqual([sourceScope.id]);
          expect(selection.scopeCluster?.paths).toEqual([sourcePath]);
          expect(selection.scopeCluster?.globs).toEqual([`${sourcePath}/**/*`]);
        }
        expect(
          assessRalphScopeRegistryAvailability(registry, { now }),
        ).toMatchObject({
          activeScopeCount: 1,
          selectableScopeCount: 1,
        });
      }

      const cacheOnly = { ...staleRegistry, scopes: cacheScopes };
      const emptySelection = selectRalphScopeFromRegistry(cacheOnly, { now });
      expect(emptySelection.scope).toBeUndefined();
      expect(emptySelection.registry.selection.currentScopeId).toBeNull();
      expect(
        assessRalphScopeRegistryAvailability(cacheOnly, { now }),
      ).toMatchObject({
        status: "exhausted",
        activeScopeCount: 0,
      });

      const refreshed = updateRalphScopeRegistryFromEvidence(
        staleRegistry,
        { ...createEvidence(), scopes: [sourceScope, ...cacheScopes] },
        options,
      );
      expect(refreshed.removed).toEqual(cacheScopes.map((scope) => scope.id));
      expect(refreshed.registry.selection.currentScopeId).toBeNull();
      expect(refreshed.registry.selection.completedScopeIds).toEqual([]);
      for (const cacheScope of cacheScopes) {
        expect(
          refreshed.registry.scopes.find((scope) => scope.id === cacheScope.id),
        ).toMatchObject({
          status: "removed",
          selectedCount: 3,
          lastSelectedAt: now,
        });
      }
      expect(refreshed.registry.history[0]).toEqual(staleRegistry.history[0]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

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
      await mkdir(join(workspace, "target-debug1", "generated"), {
        recursive: true,
      });
      await mkdir(join(workspace, "targeting"), { recursive: true });
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
        join(workspace, "target-debug1", "generated", "lib.rs"),
        "",
        "utf8",
      );
      await writeFile(join(workspace, "targeting", "index.ts"), "", "utf8");
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
      expect(scopeIds.join("\n")).not.toContain("target-debug1");
      expect(scopeIds).toContain("targeting");
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

  it("excludes transient Minimax copies and retires previously registered copies", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-minimax-scopes-"));
    const sourcePath = "apps/client/src-tauri/python/fizgig/minimax";
    const copyPaths = [
      ".tmp/cargo-commit-check/debug/python/fizgig/minimax",
      ".tmp/h3-cargo-check/debug/python/fizgig/minimax",
    ];

    try {
      for (const path of [sourcePath, ...copyPaths]) {
        const directory = join(workspace, path);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "__init__.py"), "", "utf8");
        await writeFile(join(directory, "model.py"), "", "utf8");
        await writeFile(join(directory, "trainer.py"), "", "utf8");
      }

      const evidence = await discoverRalphScopeEvidence(workspace, {
        excludePaths: [],
        maxDepth: 8,
      });
      const sourceScope = evidence.scopes.find(
        (scope) => scope.paths[0] === sourcePath,
      );
      expect(sourceScope).toBeDefined();
      expect(evidence.excludePaths).toContain(".tmp");
      expect(
        evidence.scopes.some((scope) =>
          scope.paths.some((path) => path.startsWith(".tmp/")),
        ),
      ).toBe(false);

      const emptyRegistry = parseRalphScopeRegistry(undefined, {
        flowAlias: "test-flow",
        strategy: "start-to-end",
      });
      const registered = updateRalphScopeRegistryFromEvidence(
        emptyRegistry,
        evidence,
        { flowAlias: "test-flow", strategy: "start-to-end" },
      ).registry;
      const trackedScope = registered.scopes.find(
        (scope) => scope.id === sourceScope?.id,
      )!;
      const staleCopies = copyPaths.map((path, index) => ({
        ...trackedScope,
        id: `stale-minimax-copy-${index}`,
        paths: [path],
        globs: [`${path}/**/*`],
        priority: trackedScope.priority + 1,
      }));
      const staleRegistry = {
        ...registered,
        scopes: [trackedScope, ...staleCopies],
        selection: {
          ...registered.selection,
          currentScopeId: staleCopies[0]!.id,
          completedScopeIds: [staleCopies[1]!.id],
        },
      };
      const selection = selectRalphScopeFromRegistry(staleRegistry, {
        strategy: "priority",
      });
      expect(selection.scope?.id).toBe(trackedScope.id);
      expect(selection.reusedCurrentScope).toBe(false);
      expect(selection.scopeCluster?.paths).toEqual([sourcePath]);
      expect(selection.scopeCluster?.globs).toContain(`${sourcePath}/**/*`);
      expect(
        selectRalphScopeFromRegistry(staleRegistry, {
          strategy: "priority",
          forceNew: true,
        }).scope?.id,
      ).toBe(trackedScope.id);
      expect(assessRalphScopeRegistryAvailability(staleRegistry)).toMatchObject(
        {
          activeScopeCount: 1,
          selectableScopeCount: 1,
        },
      );

      const refreshed = updateRalphScopeRegistryFromEvidence(
        staleRegistry,
        { ...evidence, scopes: [...evidence.scopes, ...staleCopies] },
        { flowAlias: "test-flow", strategy: "start-to-end" },
      );
      expect(refreshed.removed).toEqual(staleCopies.map((scope) => scope.id));
      expect(
        refreshed.registry.scopes
          .filter((scope) => staleCopies.some((copy) => copy.id === scope.id))
          .every((scope) => scope.status === "removed"),
      ).toBe(true);
      expect(refreshed.registry.selection.currentScopeId).toBeNull();
      expect(refreshed.registry.selection.completedScopeIds).toEqual([]);

      const explicitEvidence = await discoverRalphScopeEvidence(workspace, {
        rootPath: sourcePath,
        maxDepth: 1,
      });
      expect(explicitEvidence.scopes.map((scope) => scope.paths[0])).toEqual([
        sourcePath,
      ]);
      const explicitRegistry = updateRalphScopeRegistryFromEvidence(
        refreshed.registry,
        explicitEvidence,
        { flowAlias: "test-flow", strategy: "start-to-end" },
      ).registry;
      expect(
        selectRalphScopeFromRegistry(explicitRegistry).scope?.paths,
      ).toEqual([sourcePath]);
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
    expect(isRalphScopeCoverageTerminalOutcome("no-meaningful-work")).toBe(
      true,
    );
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
    expect(secondMark.registry.selection.cycle).toBe(1);
    expect(secondMark.registry.selection.completedScopeIds).toEqual([
      "alpha",
      "beta",
    ]);

    const exhaustedSelection = selectRalphScopeFromRegistry(
      secondMark.registry,
      {
        strategy: "start-to-end",
        now: "2026-06-25T10:06:00.000Z",
      },
    );
    expect(exhaustedSelection.scope).toBeUndefined();

    const nextCycle = beginRalphScopeRegistryCycle(secondMark.registry, {
      now: "2026-06-25T10:07:00.000Z",
    });
    expect(nextCycle.cycleStarted).toBe(true);
    expect(nextCycle.registry.selection.cycle).toBe(2);
    expect(nextCycle.registry.selection.completedScopeIds).toEqual([]);
    expect(nextCycle.registry.history.at(-1)).toMatchObject({
      type: "scope-cycle-started",
      cycle: 2,
    });

    const restartedSelection = selectRalphScopeFromRegistry(
      nextCycle.registry,
      {
        strategy: "start-to-end",
        now: "2026-06-25T10:08:00.000Z",
      },
    );
    expect(restartedSelection.scope?.id).toBe("alpha");
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
    expect(stopped.registry.selection.completedScopeIds).toEqual(["alpha"]);
  });

  it("distinguishes pending scope cooldowns from evidence-backed exhaustion", () => {
    const registry = updateRalphScopeRegistryFromEvidence(
      parseRalphScopeRegistry(undefined, {
        flowAlias: "test-flow",
        strategy: "start-to-end",
        now: "2026-06-25T10:00:00.000Z",
      }),
      createEvidence(),
      {
        flowAlias: "test-flow",
        strategy: "start-to-end",
        now: "2026-06-25T10:01:00.000Z",
      },
    ).registry;
    const coolingDown = {
      ...registry,
      selection: {
        ...registry.selection,
        currentScopeId: null,
        completedScopeIds: ["beta"],
      },
      scopes: registry.scopes.map((scope) =>
        scope.id === "alpha"
          ? {
              ...scope,
              lastOutcome: "deferred" as const,
              eligibleAfter: "2026-06-25T10:31:00.000Z",
            }
          : { ...scope, lastOutcome: "completed" as const },
      ),
    };

    expect(
      assessRalphScopeRegistryAvailability(coolingDown, {
        now: "2026-06-25T10:02:00.000Z",
      }),
    ).toMatchObject({
      status: "deferred",
      activeScopeCount: 2,
      eligibleScopeCount: 1,
      selectableScopeCount: 0,
      nonTerminalScopeIds: ["alpha"],
      nextEligibleAt: "2026-06-25T10:31:00.000Z",
    });

    const exhausted = {
      ...coolingDown,
      scopes: coolingDown.scopes.map((scope) => ({
        ...scope,
        lastOutcome: "no-meaningful-work" as const,
        eligibleAfter: "2026-06-26T10:00:00.000Z",
      })),
    };

    expect(
      assessRalphScopeRegistryAvailability(exhausted, {
        now: "2026-06-25T10:02:00.000Z",
      }).status,
    ).toBe("deferred");
  });

  it("advances a lifie-style completed UI scope only after it is marked", () => {
    const registry = parseRalphScopeRegistry(
      {
        schema: "machdoch.ralph.scopeRegistry",
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
