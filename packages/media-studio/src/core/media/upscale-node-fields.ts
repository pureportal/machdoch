import type { MediaNodeFieldDefinition } from "./node-registry.js";
import { DEFAULT_UPSCALE_SETTINGS } from "./upscale-settings.js";

const field = (
  id: string,
  label: string,
  kind: MediaNodeFieldDefinition["kind"],
  defaultValue: unknown,
  extra: Partial<MediaNodeFieldDefinition> = {},
): MediaNodeFieldDefinition => ({
  id,
  label,
  kind,
  defaultValue,
  description: "",
  group: "Basic",
  required: true,
  examples: [],
  ...extra,
});
const choices = (...items: [string, string][]) =>
  items.map(([value, label]) => ({ value, label, description: "" }));

export const UPSCALE_NODE_FIELDS: readonly MediaNodeFieldDefinition[] = [
  field("modelPath", "Upscaler model", "file", "", {
    allowEmpty: true,
    maxLength: 2048,
  }),
  field("sizeMode", "Sizing", "select", "scale", {
    options: choices(
      ["scale", "Scale factor"],
      ["dimensions", "Minimum width & height"],
      ["edges", "Minimum long & short edge"],
      ["short-edge", "Minimum shortest edge"],
    ),
  }),
  field("scale", "Scale", "number", 2, {
    min: 1,
    max: 8,
    step: 0.05,
    visibleWhen: { fieldId: "sizeMode", equals: "scale" },
  }),
  ...(["minWidth", "minHeight", "minLongEdge", "minShortEdge"] as const).map(
    (id, index) =>
      field(
        id,
        [
          "Min. width (px)",
          "Min. height (px)",
          "Min. long edge (px)",
          "Min. short edge (px)",
        ][index]!,
        "number",
        DEFAULT_UPSCALE_SETTINGS[id],
        {
          min: 0,
          max: 16384,
          integer: true,
          visibleWhen: {
            fieldId: "sizeMode",
            equals:
              id === "minShortEdge"
                ? ["edges", "short-edge"]
                : id === "minLongEdge"
                  ? "edges"
                  : "dimensions",
          },
        },
      ),
  ),
  field("tileMode", "Tiles", "select", "automatic", {
    group: "Expert",
    options: choices(
      ["automatic", "Automatic"],
      ["manual", "Manual"],
      ["factor", "Divide by factor"],
      ["full", "Full frame"],
    ),
  }),
  field("tileSize", "Tile size (px)", "number", 256, {
    group: "Expert",
    min: 32,
    max: 2048,
    step: 32,
    integer: true,
    visibleWhen: { fieldId: "tileMode", equals: "manual" },
  }),
  field("tileFactor", "Tile divisor", "number", 4, {
    group: "Expert",
    min: 2,
    max: 16,
    integer: true,
    visibleWhen: { fieldId: "tileMode", equals: "factor" },
  }),
];
