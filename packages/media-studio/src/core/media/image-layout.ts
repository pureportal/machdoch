import { hash } from "fast-sha256";
import { canonicalizeMediaValue } from "./canonicalize.js";

export type MediaImageBox = [number, number, number, number];
export type MediaImageLayoutMethod = "native" | "composition" | "reference" | "masked";

interface MediaImageElementBase {
  id: string;
  description: string;
  box: MediaImageBox;
  zIndex: number;
  opacity?: number;
}

export interface MediaImageObject extends MediaImageElementBase {
  kind: "object";
  assetId?: string;
  fit?: "contain" | "cover" | "stretch";
  cutout?: boolean;
}

export interface MediaImageText extends MediaImageElementBase {
  kind: "text";
  text: string;
  font: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
  direction: "ltr" | "rtl";
}

export interface MediaImageShape extends MediaImageElementBase {
  kind: "shape";
  shape: "rectangle" | "ellipse" | "arrow";
  color: string;
}

export type MediaImageLayoutElement = MediaImageObject | MediaImageText | MediaImageShape;

export interface MediaImageLayout {
  schemaVersion: 1;
  canvas: { width: number; height: number };
  caption: string;
  background?: string;
  elements: MediaImageLayoutElement[];
  relations?: {
    kind: "left-of" | "above" | "on" | "inside";
    subjectId: string;
    objectId: string;
  }[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const color = (value: unknown): boolean => typeof value === "string" && /^#[\da-f]{6}([\da-f]{2})?$/iu.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export function mediaImageLayoutError(value: unknown): string | null {
  if (!record(value) || value.schemaVersion !== 1 || !keys(value, ["schemaVersion", "canvas", "caption", "background", "elements", "relations"]))
    return "Invalid layout document.";
  if (!record(value.canvas) || !keys(value.canvas, ["width", "height"]) || !integer(value.canvas.width, 1, 8192) || !integer(value.canvas.height, 1, 8192))
    return "Canvas dimensions must be whole pixels between 1 and 8192.";
  if (!text(value.caption, 16000) || (value.background !== undefined && !color(value.background)))
    return "Enter a valid caption and background color.";
  if (!Array.isArray(value.elements) || value.elements.length > 256)
    return "A layout supports up to 256 elements.";
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!record(element) || !text(element.id, 64) || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(element.id) || ids.has(element.id))
      return "Each element needs a unique ID starting with a letter.";
    ids.add(element.id);
    if (!text(element.description, 4000) || !integer(element.zIndex, -10000, 10000))
      return `Invalid description or layer for ${element.id}.`;
    const box = element.box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((coordinate) => integer(coordinate, 0, 8192)) ||
        box[0] >= box[2] || box[1] >= box[3] || box[2] > value.canvas.width || box[3] > value.canvas.height)
      return `Keep ${element.id} inside the canvas with positive width and height.`;
    if (element.opacity !== undefined && (typeof element.opacity !== "number" || !Number.isFinite(element.opacity) || element.opacity < 0 || element.opacity > 1))
      return `Opacity for ${element.id} must be between 0 and 1.`;
    const common = ["id", "kind", "description", "box", "zIndex", "opacity"];
    if (element.kind === "object") {
      if (!keys(element, [...common, "assetId", "fit", "cutout"]) ||
          (element.assetId !== undefined && (!text(element.assetId, 256) || !element.assetId.trim())) ||
          (element.fit !== undefined && !["contain", "cover", "stretch"].includes(String(element.fit))) ||
          (element.cutout !== undefined && typeof element.cutout !== "boolean"))
        return `Invalid asset settings for ${element.id}.`;
    } else if (element.kind === "text") {
      if (!keys(element, [...common, "text", "font", "fontSize", "color", "align", "direction"]) ||
          !text(element.text, 8000) || !element.text.length || !text(element.font, 256) || !element.font.trim() ||
          !integer(element.fontSize, 1, 1024) || !color(element.color) ||
          !["left", "center", "right"].includes(String(element.align)) || !["ltr", "rtl"].includes(String(element.direction)))
        return `Choose text, font, size, color and alignment for ${element.id}.`;
    } else if (element.kind === "shape") {
      if (!keys(element, [...common, "shape", "color"]) || !["rectangle", "ellipse", "arrow"].includes(String(element.shape)) || !color(element.color))
        return `Invalid shape for ${element.id}.`;
    } else return `Invalid element kind for ${element.id}.`;
  }
  if (value.relations !== undefined && (!Array.isArray(value.relations) || value.relations.length > 1024 ||
      value.relations.some((relation) => !record(relation) || !keys(relation, ["kind", "subjectId", "objectId"]) ||
        !["left-of", "above", "on", "inside"].includes(String(relation.kind)) ||
        !ids.has(String(relation.subjectId)) || !ids.has(String(relation.objectId)) || relation.subjectId === relation.objectId)))
    return "Relations must refer to two different existing elements.";
  return null;
}

export function parseMediaImageLayout(value: unknown): MediaImageLayout {
  const error = mediaImageLayoutError(value);
  if (error) throw new Error(error);
  return structuredClone(value) as MediaImageLayout;
}

export function resizeMediaImageLayout(layout: MediaImageLayout, width: number, height: number, mode: "scale" | "anchor"): MediaImageLayout {
  const resized = structuredClone(layout);
  resized.canvas = { width, height };
  if (mode === "scale") {
    const sx = width / layout.canvas.width;
    const sy = height / layout.canvas.height;
    for (const element of resized.elements) {
      element.box = element.box.map((coordinate, index) => Math.round(coordinate * (index % 2 === 0 ? sx : sy))) as MediaImageBox;
      if (element.kind === "text") element.fontSize = Math.max(1, Math.round(element.fontSize * Math.min(sx, sy)));
    }
  }
  return parseMediaImageLayout(resized);
}

export function orderedMediaImageElements(layout: MediaImageLayout): MediaImageLayoutElement[] {
  return [...layout.elements].sort((a, b) => a.zIndex - b.zIndex);
}

export function mediaImageLayoutDigest(layout: MediaImageLayout): string {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeMediaValue(parseMediaImageLayout(layout))));
  return Array.from(hash(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const emptyMediaImageLayout = (): MediaImageLayout => ({
  schemaVersion: 1, canvas: { width: 1024, height: 1024 }, caption: "", background: "#ffffff", elements: [],
});
