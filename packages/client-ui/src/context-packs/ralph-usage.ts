interface RalphContextPackFlow {
  id: string;
  name: string;
  blocks: Array<{
    type: string;
    settings?: { packs?: string[] };
    packIds?: string[];
  }>;
}

export async function loadRalphContextPackUsage(
  workspaceRoot: string,
  listFlows: (
    workspaceRoot: string,
  ) => Promise<{ flows: Array<{ id: string }> }>,
  showFlow: (
    workspaceRoot: string,
    flowId: string,
  ) => Promise<{ flow: RalphContextPackFlow }>,
): Promise<Record<string, string[]>> {
  const summaries = await listFlows(workspaceRoot);
  const usage: Record<string, string[]> = {};
  for (const summary of summaries.flows) {
    const { flow } = await showFlow(workspaceRoot, summary.id);
    const packIds = new Set(
      flow.blocks.flatMap((block) => [
        ...(block.settings?.packs ?? []),
        ...(block.type === "PACK" ? (block.packIds ?? []) : []),
      ]),
    );
    for (const packId of packIds)
      usage[packId] = [...(usage[packId] ?? []), flow.name || flow.id];
  }
  return usage;
}
