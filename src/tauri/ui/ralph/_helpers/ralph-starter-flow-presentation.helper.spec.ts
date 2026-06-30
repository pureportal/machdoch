import type { RalphFlowSummary } from "../../../../core/ralph.js";
import {
  STARTER_RALPH_FLOW_SUMMARIES,
  createStarterImportId,
  formatStarterFlowSubtitle,
  getStarterFlowById,
  getStarterFlowEmoji,
  getStarterFlowUpdate,
} from "./ralph-starter-flow-presentation.helper";

describe("ralph starter flow presentation helper", () => {
  it("exposes summaries and lookup for bundled starter flows", () => {
    const summary = STARTER_RALPH_FLOW_SUMMARIES.find(
      (starterFlow) => starterFlow.id === "security-fix-loop",
    );

    expect(summary).toBeDefined();
    expect(getStarterFlowById("security-fix-loop")?.id).toBe(
      "security-fix-loop",
    );
    expect(getStarterFlowById("missing")).toBeUndefined();
  });

  it("detects when an imported starter flow has an available update", () => {
    const starterFlow = getStarterFlowById("security-fix-loop");
    expect(starterFlow).toBeDefined();

    const flow: RalphFlowSummary = {
      id: "imported-flow",
      name: "Imported Flow",
      path: "flow.json",
      blockCount: 1,
      edgeCount: 0,
      variableCount: 0,
      source: {
        kind: "starter",
        id: "security-fix-loop",
        version: starterFlow!.version - 1,
      },
    };

    expect(getStarterFlowUpdate(flow)).toEqual({
      latestVersion: starterFlow!.version,
    });
    expect(
      getStarterFlowUpdate({
        ...flow,
        source: { ...flow.source!, version: starterFlow!.version },
      }),
    ).toBeNull();
    expect(getStarterFlowUpdate({ ...flow, source: undefined })).toBeNull();
  });

  it("formats starter flow subtitles and emojis", () => {
    const summary = STARTER_RALPH_FLOW_SUMMARIES[0]!;

    expect(formatStarterFlowSubtitle(summary)).toBe(
      `${summary.category} / ${summary.blockCount} blocks / ${summary.edgeCount} edges / ${summary.variableCount} vars`,
    );
    expect(getStarterFlowEmoji(summary)).toBeTruthy();
  });

  it("uses crypto UUIDs for import ids when available", () => {
    const starterFlow = getStarterFlowById("security-fix-loop")!;
    const originalCrypto = globalThis.crypto;
    const randomUUID = vi.fn(() => "uuid-1");

    vi.stubGlobal("crypto", { randomUUID });

    try {
      expect(createStarterImportId(starterFlow)).toBe("uuid-1");
      expect(randomUUID).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("crypto", originalCrypto);
    }
  });
});
