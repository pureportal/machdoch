import { describe, expect, it, vi } from "vitest";
import type { MediaFlow } from "../../../core/media/contracts.js";
import { listMediaNodeDefinitions } from "../../../core/media/node-registry.js";
import { createMediaNodeCommandPage } from "./media-node-command-page";

describe("Media node command page", () => {
  it("groups registry definitions and assigns stable explicit numeric keys", () => {
    const flow = { nodes: [] } as unknown as MediaFlow;
    const page = createMediaNodeCommandPage(flow, () => true);
    const items = page.groups.flatMap(({ items }) => items);
    expect(items).toHaveLength(listMediaNodeDefinitions().length);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(
      listMediaNodeDefinitions()
        .slice(0, 9)
        .map(
          (definition) => byId.get(`media.node.${definition.type}`)?.numericKey,
        ),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("executes the shared add action and disables max-instance definitions", async () => {
    const limited = listMediaNodeDefinitions().find(
      ({ maxInstances }) => maxInstances === 1,
    );
    expect(limited).toBeDefined();
    const flow = {
      nodes: [{ id: "existing", type: limited!.type }],
    } as unknown as MediaFlow;
    const add = vi.fn(() => true);
    const page = createMediaNodeCommandPage(flow, add);
    const items = page.groups.flatMap(({ items }) => items);
    const disabled = items.find(
      ({ id }) => id === `media.node.${limited!.type}`,
    );
    expect(disabled?.availability?.state).toBe("disabled");
    const enabled = items.find(
      ({ availability }) => availability?.state === "enabled",
    )!;
    await enabled.execute({} as never, new AbortController().signal);
    expect(add).toHaveBeenCalledTimes(1);
  });
});
