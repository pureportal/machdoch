import {
  listRalphFlows,
  listRalphRunRecords,
  type RalphFlowScope,
  type RalphFlowSummary,
  type RalphRunSummary,
} from "./ralph.js";

export interface RalphSnapshot {
  workspaceRoot: string;
  scopes: Array<{
    scope: RalphFlowScope;
    flows: RalphFlowSummary[];
    runs: RalphRunSummary[];
  }>;
}

export const loadRalphSnapshot = async (
  workspaceRoot: string,
): Promise<RalphSnapshot> => ({
  workspaceRoot,
  scopes: await Promise.all(
    (["workspace", "user"] as const).map(async (scope) => {
      const [flows, runs] = await Promise.all([
        listRalphFlows(workspaceRoot, { scope }),
        listRalphRunRecords(workspaceRoot, { scope }),
      ]);
      return { scope, flows, runs };
    }),
  ),
});
