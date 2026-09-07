import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlow } from "./__test__/ralph-test-helpers.js";
import {
  getRalphFlowDirectory,
  listRalphFlows,
  listRalphRunRecords,
  validateRalphFlow,
  writeRalphFlow,
  writeRalphRunRecord,
} from "./ralph.js";
import { loadRalphSnapshot } from "./ralph-snapshot.js";

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-ralph-snapshot-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(workspaceRoot, "user-config"));
});

afterEach(async () => {
  if (!workspaceRoot.startsWith(join(tmpdir(), "machdoch-ralph-snapshot-"))) {
    throw new Error("Unexpected test workspace path");
  }
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("Ralph snapshot storage reads", () => {
  it("returns empty scopes without creating storage or configuration", async () => {
    await expect(loadRalphSnapshot(workspaceRoot)).resolves.toEqual({
      workspaceRoot,
      scopes: [
        { scope: "workspace", flows: [], runs: [] },
        { scope: "user", flows: [], runs: [] },
      ],
    });
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it("preserves the existing flow and run summaries for both scopes", async () => {
    for (const scope of ["workspace", "user"] as const) {
      const flow = createFlow({
        name: `${scope} flow`,
        settings: { maxTransitions: 42 },
      });
      await writeRalphFlow(workspaceRoot, flow, { scope });
      await writeRalphRunRecord(
        workspaceRoot,
        flow,
        {
          flow: flow.id,
          status: "blocked",
          summary: `${scope} result`,
          missingVariables: [],
          unknownVariables: [],
          blockResults: [],
          events: [],
          validation: validateRalphFlow(flow),
        },
        { scope, runId: "same-run-id" },
      );
    }

    const snapshot = await loadRalphSnapshot(workspaceRoot);

    for (const entry of snapshot.scopes) {
      expect(entry.flows).toEqual(
        await listRalphFlows(workspaceRoot, { scope: entry.scope }),
      );
      expect(entry.runs).toEqual(
        await listRalphRunRecords(workspaceRoot, { scope: entry.scope }),
      );
      expect(entry.flows[0]).toMatchObject({
        name: `${entry.scope} flow`,
        maxTransitions: 42,
      });
      expect(entry.flows[0]?.variables.length).toBeGreaterThan(0);
      expect(entry.runs[0]).toMatchObject({
        id: "same-run-id",
        summary: `${entry.scope} result`,
      });
    }
    expect(snapshot.scopes).toHaveLength(2);
  });

  it("surfaces inaccessible scope storage instead of reporting empty data", async () => {
    await writeRalphFlow(workspaceRoot, createFlow());
    const flowDirectory = getRalphFlowDirectory(workspaceRoot);
    expect(flowDirectory).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "flows"),
    );
    await rm(flowDirectory, { recursive: true });
    await writeFile(flowDirectory, "not a directory");

    await expect(loadRalphSnapshot(workspaceRoot)).rejects.toThrow();
  });
});
