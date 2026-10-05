import { describe, expect, it } from "vitest";

import type { RalphFlowBlock } from "../../../../core/ralph.js";
import { createBlankFlow } from "./create-blank-ralph-flow.helper";
import { getFlowLayoutKey } from "./ralph-flow-editor-state.helper";

describe("Ralph canvas layout identity", () => {
  it("resets cached positions when a phase collapses or expands", () => {
    const group: RalphFlowBlock = {
      id: "phase",
      type: "GROUP",
      title: "Plan",
      childBlockIds: [],
      position: { x: 3000, y: 100 },
      size: { width: 2400, height: 1800 },
    };
    const expanded = { ...createBlankFlow("phases"), blocks: [group] };
    const collapsed = {
      ...expanded,
      blocks: [{ ...group, collapsed: true }],
    };
    expect(getFlowLayoutKey(collapsed)).not.toBe(getFlowLayoutKey(expanded));
    expect(
      getFlowLayoutKey({
        ...collapsed,
        blocks: [{ ...group, collapsed: false }],
      }),
    ).toBe(getFlowLayoutKey(expanded));
  });

  it("preserves canvas positions for edits that do not change geometry", () => {
    const flow = createBlankFlow("labels");
    expect(
      getFlowLayoutKey({
        ...flow,
        blocks: flow.blocks.map((block) => ({ ...block, title: "Updated" })),
      }),
    ).toBe(getFlowLayoutKey(flow));
  });
});
