import type { SpeechCastBinding } from "./compiler.ts";
import type { SpeechCastMember, SpeechProject,SpeechVoiceObservation } from "./runtime.ts";
import { parseSpeechScript } from "./script.ts";

export interface SpeechSceneOverride {
  sceneId: string;
  voiceId?: string;
  voiceObservation?:SpeechVoiceObservation;
  referenceAssetIds: string[];
  direction: string;
  rightsEvidence?: string;
}

export interface SpeechSceneBindingOverride {
  sceneId: string;
  voiceId?: string;
  referenceHashes?: string[];
  direction: string;
}

export function resolveSpeechSceneBinding(
  binding: SpeechCastBinding,
  [chapterId, sceneId]: readonly [
    chapterId: string | null | undefined,
    sceneId: string | null | undefined,
  ],
): SpeechCastBinding {
  const overrides = binding.sceneOverrides;
  const override =
    overrides?.find((value) => value.sceneId === sceneId) ??
    overrides?.find((value) => value.sceneId === chapterId);
  if (!override) return binding;
  const resolved={...binding,direction:override.direction};
  delete resolved.voiceId;delete resolved.referenceHashes;
  if(override.voiceId!==undefined)resolved.voiceId=override.voiceId;
  if(override.referenceHashes!==undefined)resolved.referenceHashes=override.referenceHashes.slice();
  return resolved;
}

export function collectSpeechReferenceAssetIds(
  cast: readonly SpeechCastMember[],
): string[] {
  const ids = new Set<string>();
  for (const member of cast) {
    for (const id of member.referenceAssetIds) ids.add(id);
    for (const override of member.sceneOverrides ?? []) {
      for (const id of override.referenceAssetIds) ids.add(id);
    }
  }
  return [...ids];
}

function validateId(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a nonblank string.`);
  }
}

function validateProjectBinding(
  binding: Pick<
    SpeechCastMember,
    "voiceId" | "referenceAssetIds" | "direction" | "rightsEvidence"
  >,
): void {
  if (binding.voiceId !== undefined) validateId(binding.voiceId, "Voice ID");
  if (!Array.isArray(binding.referenceAssetIds)) {
    throw new Error("Reference asset IDs must be an array.");
  }
  for (const id of binding.referenceAssetIds)
    validateId(id, "Reference asset ID");
  if (binding.voiceId !== undefined && binding.referenceAssetIds.length) {
    throw new Error(
      "Choose either a voice ID or reference assets for each binding.",
    );
  }
  if (
    typeof binding.direction !== "string" ||
    /[<>[\]\r\n]/u.test(binding.direction)
  ) {
    throw new Error("Direction must be plain text without control delimiters.");
  }
  if (binding.rightsEvidence !== undefined) {
    validateId(binding.rightsEvidence, "Rights evidence");
  }
}

export function validateSpeechCastStructure(
  project: Pick<SpeechProject, "source"> & { cast: readonly SpeechCastMember[] },
): void {
  if (
    !project ||
    typeof project.source !== "string" ||
    !Array.isArray(project.cast)
  ) {
    throw new Error("A project needs script text and a cast array.");
  }
  const scopeIds = new Set(
    parseSpeechScript(project.source)
      .nodes.filter((node) => node.kind === "chapter" || node.kind === "scene")
      .map((node) => node.id),
  );
  const castIds = new Set<string>();
  for (const member of project.cast) {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error("Each cast member must be an object.");
    }
    validateId(member.id, "Cast ID");
    if (castIds.has(member.id)) throw new Error("Cast IDs must be unique.");
    castIds.add(member.id);
    validateProjectBinding(member);
    if (member.sceneOverrides === undefined) continue;
    if (!Array.isArray(member.sceneOverrides)) {
      throw new Error("Scene overrides must be an array.");
    }
    const overrideIds = new Set<string>();
    for (const override of member.sceneOverrides) {
      if (
        !override ||
        typeof override !== "object" ||
        Array.isArray(override)
      ) {
        throw new Error("Each scene override must be an object.");
      }
      validateId(override.sceneId, "Scene override scope ID");
      if (overrideIds.has(override.sceneId)) {
        throw new Error(
          "Scene override scope IDs must be unique within each cast member.",
        );
      }
      overrideIds.add(override.sceneId);
      if (!scopeIds.has(override.sceneId)) {
        throw new Error(
          `Scene override scope ${override.sceneId} is not a chapter or scene in this script.`,
        );
      }
      validateProjectBinding(override);
    }
  }
}

export function validateSpeechProjectCast(
  project: Pick<SpeechProject, "source"> & { cast: readonly SpeechCastMember[] },
  references: ReadonlyMap<string, { rightsEvidence: string }>,
): void {
  validateSpeechCastStructure(project);
  for (const id of collectSpeechReferenceAssetIds(project.cast)) {
    const reference = references.get(id);
    if (!reference) throw new Error(`Reference asset ${id} is unavailable.`);
    if (
      typeof reference.rightsEvidence !== "string" ||
      !reference.rightsEvidence.trim()
    ) {
      throw new Error(
        `Record permission or rights evidence for reference asset ${id}.`,
      );
    }
  }
}

export function speechCastBindings(
  cast: readonly SpeechCastMember[],
  hash: (id: string) => string | undefined,
): SpeechCastBinding[] {
  const hashes = (ids: string[]) =>
    ids.flatMap((id) => {
      const value = hash(id);
      return value ? [value] : [];
    });
  return cast.map((member) => ({
    id: member.id,
    name: member.name,
    ...(member.voiceId!==undefined?{voiceId:member.voiceId}:{}),
    direction: member.direction,
    referenceHashes: hashes(member.referenceAssetIds),
    ...(member.sceneOverrides
      ? {
          sceneOverrides: member.sceneOverrides.map((override) => ({
            sceneId: override.sceneId,
              ...(override.voiceId!==undefined?{voiceId:override.voiceId}:{}),
            direction: override.direction,
            referenceHashes: hashes(override.referenceAssetIds),
          })),
        }
      : {}),
  }));
}
