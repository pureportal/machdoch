import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STARTER_RALPH_FLOWS,
  createImportedRalphStarterFlow,
  createUpgradedRalphStarterFlowWithReport,
  type RalphStarterFlow,
} from "./ralph-starter-flows.js";
import {
  createRalphFlowFingerprint,
  readRalphFlow,
  writeRalphFlow,
} from "./ralph.js";

describe("persisted Ralph starter upgrades", () => {
  it("recognizes every unmodified starter after a write/read round trip", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-starter-upgrade-"));

    try {
      for (const starter of STARTER_RALPH_FLOWS) {
        const imported = createImportedRalphStarterFlow(starter, {
          id: `persisted-${starter.id}`,
          alias: `persisted-${starter.id}`,
          importedAt: "2026-07-10T00:00:00.000Z",
        });
        await writeRalphFlow(workspaceRoot, imported);
        const persisted = await readRalphFlow(workspaceRoot, imported.id);
        const upgrade = createUpgradedRalphStarterFlowWithReport(
          persisted,
          starter,
          "2026-07-10T01:00:00.000Z",
        );

        expect(upgrade.report.applied, starter.id).toBe(true);
        expect(upgrade.report.strategy, starter.id).toBe("replace-unmodified");
        expect(upgrade.report.conflicts, starter.id).toEqual([]);
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("three-way merges upstream structure while preserving conflicting local edits", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-starter-merge-"));
    const starter = STARTER_RALPH_FLOWS.find(
      (candidate) => candidate.id === "autonomous-code-improvement-loop",
    )!;

    try {
      const imported = createImportedRalphStarterFlow(starter, {
        id: "customized-upgrade",
        alias: "customized-upgrade",
        importedAt: "2026-07-10T00:00:00.000Z",
      });
      await writeRalphFlow(workspaceRoot, imported);
      const local = await readRalphFlow(workspaceRoot, imported.id);
      const importedFingerprint = createRalphFlowFingerprint(local);
      local.description = "Keep this local description";
      await writeRalphFlow(workspaceRoot, local, {
        expectedFingerprint: importedFingerprint,
      });
      const persistedLocal = await readRalphFlow(workspaceRoot, local.id);
      const nextStarter = JSON.parse(JSON.stringify(starter)) as RalphStarterFlow;
      nextStarter.version += 1;
      nextStarter.flow.name = "Upstream Improved Name";
      nextStarter.flow.description = "Upstream changed description";
      nextStarter.flow.blocks.push({
        id: "upstream-release-note",
        type: "NOTE",
        title: "Upstream Release Note",
        text: "New upstream guidance",
      });
      const upgrade = createUpgradedRalphStarterFlowWithReport(
        persistedLocal,
        nextStarter,
        "2026-07-10T02:00:00.000Z",
      );

      expect(upgrade.report.applied).toBe(true);
      expect(upgrade.report.strategy).toBe("three-way-merge");
      expect(upgrade.flow.description).toBe("Keep this local description");
      expect(upgrade.flow.name).toBe("Upstream Improved Name");
      expect(upgrade.flow.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "upstream-release-note" }),
        ]),
      );
      expect(upgrade.report.conflicts).toEqual([
        expect.stringContaining("description"),
      ]);

      await writeRalphFlow(workspaceRoot, upgrade.flow, {
        expectedFingerprint: createRalphFlowFingerprint(persistedLocal),
      });
      await expect(readRalphFlow(workspaceRoot, local.id)).resolves.toMatchObject({
        name: "Upstream Improved Name",
        source: { version: nextStarter.version },
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
