import type { CompiledSpeech, CompiledSpeechSegment } from "./compiler.ts";
import { orderedProductionTakes, validateSpeechExportPreset } from "./production.ts";
import type { SpeechExportInput, SpeechExportPreset, SpeechProject, SpeechTake } from "./runtime.ts";

export type SpeechExportGroupKind = "chapter" | "scene" | "speaker";

export interface SpeechExportGroup {
  kind: SpeechExportGroupKind;
  id: string;
  title: string;
  request: SpeechExportInput;
}

export interface SpeechExportGroupOptions {
  project: SpeechProject;
  takes: SpeechTake[];
  compiled: CompiledSpeech;
  groupBy: SpeechExportGroupKind;
  settings: SpeechExportPreset;
  outputDirectory: string;
  overwrite: boolean;
}

type ScopeBoundary = CompiledSpeech["script"]["nodes"][number];

function segmentScene(
  segment: CompiledSpeechSegment,
  boundaries: readonly ScopeBoundary[],
  sourceLength: number,
): ScopeBoundary {
  let scene: ScopeBoundary | undefined;
  for (const range of segment.sourceMap) {
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (boundaries[middle]!.from <= range.from) low = middle + 1;
      else high = middle;
    }
    const boundary = boundaries[low - 1];
    if (
      !boundary ||
      boundary.kind !== "scene" ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from < boundary.to ||
      range.to <= range.from ||
      range.to > (boundaries[low]?.from ?? sourceLength)
    )
      throw new Error("Place every selected segment entirely inside a scene before exporting scenes.");
    if (scene && scene.id !== boundary.id)
      throw new Error("A selected segment spans multiple scenes. Compile it again before exporting.");
    scene = boundary;
  }
  if (!scene)
    throw new Error("A selected segment has no scene source map. Compile it again before exporting.");
  return scene;
}

function exportFilename(
  projectId: string,
  group: { id: string; title: string },
  kind: SpeechExportGroupKind,
  ordinal: string,
  format: SpeechExportPreset["format"],
): string {
  const title = Array.from(
    group.title
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "-")
      .replace(/\s+/gu, "-")
      .replace(/-+/gu, "-"),
  )
    .slice(0, 40)
    .join("")
    .replace(/^[ .-]+|[ .-]+$/gu, "");
  const identity = JSON.stringify([projectId, kind, group.id]);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < identity.length; index++) {
    first = Math.imul(first ^ identity.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ identity.charCodeAt(index);
  }
  const fingerprint = [first, second]
    .map(value => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return [ordinal, kind, ...(title ? [title] : []), fingerprint].join("-") + "." + format;
}

export function planSpeechExportGroups({
  project,
  takes,
  compiled,
  groupBy,
  settings,
  outputDirectory,
  overwrite,
}: SpeechExportGroupOptions): SpeechExportGroup[] {
  validateSpeechExportPreset(settings);
  if (settings.format === "archive")
    throw new Error("Export the complete project separately when creating a portable archive.");
  if (!["chapter", "scene", "speaker"].includes(groupBy))
    throw new Error("Choose chapter, scene, or speaker exports.");
  if (
    !outputDirectory.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(outputDirectory)
  )
    throw new Error("Choose an export directory without control characters.");
  if (
    compiled.script.source !== project.source ||
    compiled.diagnostics.some(diagnostic => diagnostic.severity === "error")
  )
    throw new Error("Compile the current project without script errors before exporting groups.");

  const selected = orderedProductionTakes(
    project,
    takes,
    compiled.segments.map(segment => segment.id),
    false,
  );
  if (!selected.length)
    throw new Error("Select a rendered take for a current script segment before exporting groups.");

  const segments = new Map(compiled.segments.map(segment => [segment.id, segment]));
  const cast = new Map(project.cast.map(member => [member.id, member]));
  const boundaries = compiled.script.nodes.filter(node => node.kind === "chapter" || node.kind === "scene");
  const groups = new Map<string, { id: string; title: string; takeIds: string[] }>();

  for (const take of selected) {
    const segment = segments.get(take.segmentId)!;
    let id: string;
    let title: string;
    if (groupBy === "chapter") {
      if (!segment.chapter)
        throw new Error("Place every selected segment inside a chapter before exporting chapters.");
      ({ id, title } = segment.chapter);
    } else if (groupBy === "scene") {
      const scene = segmentScene(segment, boundaries, compiled.script.source.length);
      id = scene.id;
      title = scene.value;
    } else {
      if (segment.speakers.length !== 1)
        throw new Error("Speaker stems require exactly one cast member per selected segment. Mixed dialogue cannot be separated.");
      const speaker = cast.get(segment.speakers[0]!.id);
      if (!speaker)
        throw new Error("A selected segment has no current cast identity. Compile it again before exporting speaker stems.");
      id = speaker.id;
      title = speaker.name;
    }
    const group = groups.get(id);
    if (group) group.takeIds.push(take.id);
    else groups.set(id, { id, title, takeIds: [take.id] });
  }

  const directory = outputDirectory.replace(/[\\/]+$/u, "");
  const separator = outputDirectory.includes("\\") ? "\\" : "/";
  const width = Math.max(3, String(groups.size).length);
  return Array.from(groups.values(), (group, index) => {
    const clips=project.timeline.filter(clip=>group.takeIds.includes(clip.takeId));
    if(project.timeline.length&&group.takeIds.some(id=>!clips.some(clip=>clip.takeId===id)))throw new Error("Place every selected take on the timeline before exporting edited groups.");
    const range=clips.length&&groupBy!=="speaker"?{from:Math.min(...clips.map(clip=>clip.start)),to:Math.max(...clips.map(clip=>clip.start+clip.out-clip.in))}:undefined;
    return ({
    kind: groupBy,
    id: group.id,
    title: group.title,
    request: {
      projectId: project.id,
      revisionId: project.revisionId,
      takeIds: clips.length?[]:group.takeIds,
      ...(clips.length?{clipIds:clips.map(clip=>clip.id)}:{}),
      ...(range?{range}:{}),
      format: settings.format,
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      bitrate: settings.bitrate,
      loudnessLufs: settings.loudnessLufs,
      truePeakDb: settings.truePeakDb,
      outputPath: directory + separator + exportFilename(
        project.id,
        group,
        groupBy,
        String(index + 1).padStart(width, "0"),
        settings.format,
      ),
      overwrite,
      includeBackground: false,
    },
  });});
}
