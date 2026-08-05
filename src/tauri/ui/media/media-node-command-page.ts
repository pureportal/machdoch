import type {
  MediaFlow,
  MediaNodeType,
} from "../../../core/media/contracts.js";
import { listMediaNodeDefinitions } from "../../../core/media/node-registry.js";
import type { CommandPage, CommandPageItem } from "../commands/command-types";

export const createMediaNodeCommandPage = (
  flow: MediaFlow,
  onAdd: (nodeType: MediaNodeType) => boolean,
): CommandPage => {
  const definitions = listMediaNodeDefinitions();
  const numericKeys = new Map(
    definitions
      .slice(0, 9)
      .map((definition, index) => [
        definition.type,
        String(index + 1) as CommandPageItem["numericKey"],
      ]),
  );
  const categories = [...new Set(definitions.map(({ category }) => category))];
  return {
    id: "media.flow.node.add",
    title: "Add node",
    searchPlaceholder: "Search nodes",
    numericSelection: true,
    groups: categories.map((category) => ({
      id: category.toLocaleLowerCase("en-US"),
      label: category,
      items: definitions
        .filter((definition) => definition.category === category)
        .map((definition): CommandPageItem => {
          const existingCount = flow.nodes.filter(
            (node) => node.type === definition.type,
          ).length;
          const atLimit =
            definition.maxInstances !== undefined &&
            existingCount >= definition.maxInstances;
          return {
            id: `media.node.${definition.type}`,
            title: definition.displayName,
            keywords: [
              definition.type,
              definition.summary,
              definition.category,
              ...definition.inputs.map((port) => port.dataType),
              ...definition.outputs.map((port) => port.dataType),
            ],
            numericKey: numericKeys.get(definition.type),
            availability: atLimit
              ? {
                  state: "disabled",
                  reason: `${definition.displayName} is already added`,
                }
              : { state: "enabled" },
            execute: () =>
              onAdd(definition.type)
                ? { type: "close" }
                : { type: "stay-open" },
          };
        }),
    })),
  };
};
