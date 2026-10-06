import type { MediaRefModSelection } from "./contracts.js";

export const isActiveRefMod = (selection: MediaRefModSelection): boolean =>
  selection.enabled &&
  ((selection.selection !== "audio" && selection.visualStrength > 0) ||
    (selection.selection !== "visual" && selection.audioStrength > 0));

export function readRefMods(value: unknown): MediaRefModSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Choose at most 256 RefMods.");
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null)
      throw new Error("Invalid RefMod selection.");
    const record = entry as Record<string, unknown>;
    const curves = ["constant", "increase", "decrease", "middle", "ends"];
    if (
      typeof record.path !== "string" ||
      !record.path.trim() ||
      typeof record.enabled !== "boolean" ||
      !["all", "visual", "audio"].includes(String(record.selection)) ||
      typeof record.visualStrength !== "number" ||
      !Number.isFinite(record.visualStrength) ||
      record.visualStrength < 0 ||
      record.visualStrength > 1 ||
      typeof record.audioStrength !== "number" ||
      !Number.isFinite(record.audioStrength) ||
      record.audioStrength < 0 ||
      record.audioStrength > 1 ||
      typeof record.copies !== "number" ||
      !Number.isInteger(record.copies) ||
      record.copies < 1 ||
      record.copies > 8 ||
      (record.stepCurve !== undefined &&
        !curves.includes(String(record.stepCurve))) ||
      (record.frameCurve !== undefined &&
        !curves.includes(String(record.frameCurve)))
    ) {
      throw new Error("Choose a RefMod, strengths from 0 to 1 and 1–8 copies.");
    }
    return {
      path: record.path,
      enabled: record.enabled,
      selection: record.selection as MediaRefModSelection["selection"],
      visualStrength: record.visualStrength,
      audioStrength: record.audioStrength,
      copies: record.copies,
      ...(record.stepCurve === undefined
        ? {}
        : {
            stepCurve: record.stepCurve as NonNullable<
              MediaRefModSelection["stepCurve"]
            >,
          }),
      ...(record.frameCurve === undefined
        ? {}
        : {
            frameCurve: record.frameCurve as NonNullable<
              MediaRefModSelection["frameCurve"]
            >,
          }),
    };
  });
}
