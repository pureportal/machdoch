import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSpeechScript, type CompiledSpeech } from "./compiler.ts";
import { DEFAULT_SPEECH_EXPORT } from "./production.ts";
import {
  planSpeechExportGroups,
  type SpeechExportGroupOptions,
} from "./export-groups.ts";
import type { SpeechCastMember, SpeechExportInput, SpeechProject, SpeechTake } from "./runtime.ts";

type ScriptPart = readonly ["chapter" | "scene" | "speaker" | "text", string];

function fixture(
  parts: readonly ScriptPart[],
  segmentTargetUtf8Bytes = 1,
): SpeechExportGroupOptions {
  let source = "";
  const nodes = parts.map(([kind, value], index) => {
    const from = source.length;
    const raw = value + "\n";
    source += raw;
    return { id: "node-" + index, kind, value, raw, from, to: source.length };
  });
  const cast: SpeechCastMember[] = [
    { id: "alice", name: "Alice", voiceId: "shared-voice", referenceAssetIds: [], direction: "" },
    { id: "bob", name: "Bob", voiceId: "shared-voice", referenceAssetIds: [], direction: "" },
  ];
  const compiled = compileSpeechScript(
    { source, nodes, diagnostics: [] } as CompiledSpeech["script"],
    {
      cast: cast.map(member => ({ id: member.id, name: member.name, voiceId: member.voiceId })),
      defaultSpeakerId: "alice",
      segmentTargetUtf8Bytes,
    },
  );
  assert.equal(compiled.diagnostics.some(item => item.severity === "error"), false);
  const timestamp = "2026-10-19T12:00:00Z";
  const takes: SpeechTake[] = compiled.segments.map((segment, index) => ({
    id: "take-" + (index + 1),
    projectId: "book",
    revisionId: "render-revision",
    segmentId: segment.id,
    spokenText: segment.spokenText,
    chapter: segment.chapter,
    asset: {
      id: "asset-" + index,
      sha256: "0".repeat(64),
      mimeType: "audio/wav",
      bytes: 100,
      duration: 1,
      sampleRate: 48000,
      channels: 2,
      path: "D:\\Models\\machdoch\\speech\\assets\\" + index + ".wav",
    },
    createdAt: timestamp,
    generatedAt: timestamp,
    reusedFromTakeId: null,
    backend: "fish-cloud",
    model: "drama-3",
    requestHash: "request-" + index,
    parentTakeId: null,
    favorite: false,
    rating: null,
    note: "",
    alignment: [],
  }));
  const project: SpeechProject = {
    id: "book",
    title: "Book",
    source,
    cast,
    profileId: null,
    revisionId: "current-revision",
    parentRevisionId: "render-revision",
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    location: null,
    timeline: [],
    selectedTakes: Object.fromEntries(takes.map(take => [take.segmentId, take.id])),
    bookmarks: [],
    variants: [],
  };
  return {
    project,
    takes,
    compiled,
    groupBy: "chapter",
    settings: { ...DEFAULT_SPEECH_EXPORT },
    outputDirectory: "D:\\Exports",
    overwrite: false,
  };
}

test("chapters use current compiled metadata and selected takes in source order without mutating input", () => {
  const options = fixture([
    ["chapter", "One"],
    ["text", "First."],
    ["scene", "Opening"],
    ["text", "Second."],
    ["chapter", "Two"],
    ["text", "Third."],
  ]);
  const [first, unselected, third] = options.takes;
  assert.ok(first && unselected && third);
  delete options.project.selectedTakes[unselected.segmentId];
  options.project.selectedTakes.deleted = "obsolete";
  first.chapter = { id: "old-heading", title: "Old title" };
  const alternate = { ...first, id: "alternate" };
  options.takes = [third, alternate, unselected, first];
  const before = JSON.stringify(options);
  const groups = planSpeechExportGroups(options);
  assert.equal(JSON.stringify(options), before);
  assert.deepEqual(groups.map(group => [group.title, group.request.takeIds]), [
    ["One", [first.id]],
    ["Two", [third.id]],
  ]);
  assert.deepEqual(groups[0]!.request, {
    ...DEFAULT_SPEECH_EXPORT,
    projectId: options.project.id,
    revisionId: options.project.revisionId,
    takeIds: [first.id],
    outputPath: groups[0]!.request.outputPath,
    overwrite: false,
    includeBackground: false,
  });
  assert.match(groups[0]!.request.outputPath, /^D:\\Exports\\001-chapter-One-[a-f0-9]{16}\.wav$/u);
  assert.deepEqual(planSpeechExportGroups(options), groups);
});

test("repeated scene titles export exact edited clip groups with measured scope ranges", () => {
  const options = fixture([
    ["chapter", "One"],
    ["scene", "Repeat"],
    ["text", "First line."],
    ["text", "Second line."],
    ["scene", "Repeat"],
    ["text", "Third line."],
    ["chapter", "Two"],
    ["scene", "Repeat"],
    ["text", "Fourth line."],
  ]);
  options.groupBy = "scene";
  options.project.timeline = [...options.takes].reverse().map((take, index) => ({
    id: "clip-" + index,
    takeId: take.id,
    start: index * 10,
    in: 0,
    out: 1,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    track: 0,
  }));
  const settingsWithOtherRequestFields: SpeechExportInput = {
    ...options.settings,
    projectId: "other-project",
    takeIds: ["unrelated-take"],
    outputPath: "unrelated.wav",
    overwrite: true,
    includeBackground: true,
    range: { from: 0, to: 999 },
  };
  options.settings = settingsWithOtherRequestFields;
  const groups = planSpeechExportGroups(options);
  assert.equal(new Set(groups.map(group => group.id)).size, 3);
  assert.deepEqual(groups.map(group => group.request.clipIds), [
    ["clip-2", "clip-3"],
    ["clip-1"],
    ["clip-0"],
  ]);
  assert.deepEqual(groups.map(group=>group.request.range),[{from:20,to:31},{from:10,to:11},{from:0,to:1}]);
  for (const group of groups) {
    assert.equal(group.kind, "scene");
    assert.equal(group.title, "Repeat");
    assert.equal(group.request.includeBackground, false);
    assert.equal("range" in group.request, true);
    assert.equal(group.request.projectId, options.project.id);
    assert.equal(group.request.overwrite, false);
  }
});

test("speaker stems follow first appearance and cast identity even when voices are shared", () => {
  const options = fixture([
    ["scene", "First"],
    ["speaker", "bob"],
    ["text", "Bob first."],
    ["speaker", "alice"],
    ["text", "Alice next."],
    ["scene", "Second"],
    ["speaker", "bob"],
    ["text", "Bob again."],
  ]);
  options.groupBy = "speaker";
  options.takes[0]!.note = "Alice";
  options.compiled.segments[2]!.speakers = [
    { ...options.compiled.segments[2]!.speakers[0]!, voiceId: "scene-override-voice" },
  ];
  const groups = planSpeechExportGroups(options);
  assert.deepEqual(groups.map(group => [group.id, group.title, group.request.takeIds]), [
    ["bob", "Bob", ["take-1", "take-3"]],
    ["alice", "Alice", ["take-2"]],
  ]);
  assert.ok(groups.every(group => group.request.includeBackground === false));
});

test("mixed-speaker compiled segments cannot be attributed to a stem or silently omitted", () => {
  const options = fixture([
    ["scene", "Dialogue"],
    ["speaker", "alice"],
    ["text", "Hello."],
    ["speaker", "bob"],
    ["text", "Goodbye."],
  ], 16000);
  options.groupBy = "speaker";
  assert.equal(options.compiled.segments.length, 1);
  assert.equal(options.compiled.segments[0]!.speakers.length, 2);
  assert.throws(() => planSpeechExportGroups(options), /exactly one cast member.*Mixed dialogue/u);
  options.groupBy = "scene";
  assert.deepEqual(planSpeechExportGroups(options)[0]!.request.takeIds, ["take-1"]);
});

test("unselected mixed dialogue does not prevent exporting the selected single-speaker stem", () => {
  const options = fixture([
    ["scene", "Solo"],
    ["text", "Alone."],
    ["scene", "Dialogue"],
    ["speaker", "alice"],
    ["text", "Hello."],
    ["speaker", "bob"],
    ["text", "Goodbye."],
  ], 16000);
  options.groupBy = "speaker";
  delete options.project.selectedTakes[options.compiled.segments[1]!.id];
  assert.deepEqual(planSpeechExportGroups(options).map(group => group.request.takeIds), [["take-1"]]);
});

test("speaker stems require compiled proof of a current cast identity", () => {
  const options = fixture([["text", "Hello."]]);
  options.groupBy = "speaker";
  const segment = options.compiled.segments[0]!;
  segment.speakers = [];
  assert.throws(() => planSpeechExportGroups(options), /exactly one cast member/u);
  segment.speakers = [{ id: "unknown", name: "Alice", voiceId: "shared-voice" }];
  assert.throws(() => planSpeechExportGroups(options), /no current cast identity/u);
});

test("selected takes must exist and belong to the current project and segment", () => {
  const options = fixture([["chapter", "One"], ["text", "Hello."]]);
  const take = options.takes[0]!;
  options.project.selectedTakes[take.segmentId] = "missing";
  assert.throws(() => planSpeechExportGroups(options), /unavailable/u);
  options.project.selectedTakes[take.segmentId] = take.id;
  take.projectId = "other-project";
  assert.throws(() => planSpeechExportGroups(options), /unavailable/u);
  take.projectId = options.project.id;
  take.segmentId = "obsolete-segment";
  assert.throws(() => planSpeechExportGroups(options), /unavailable/u);
});

test("an empty selection, outdated source, or compiler errors prevent planning", () => {
  const options = fixture([["chapter", "One"], ["text", "Hello."]]);
  const selected = options.project.selectedTakes;
  options.project.selectedTakes = { deleted: "old-take" };
  assert.throws(() => planSpeechExportGroups(options), /Select a rendered take/u);
  options.project.selectedTakes = selected;
  options.project.source += "Changed";
  assert.throws(() => planSpeechExportGroups(options), /Compile the current project/u);
  options.project.source = options.compiled.script.source;
  options.compiled.diagnostics.push({
    from: 0,
    to: 1,
    severity: "error",
    code: "unmapped-speaker",
    message: "Assign a voice.",
  });
  assert.throws(() => planSpeechExportGroups(options), /Compile the current project/u);
});

test("unheaded selected content is rejected instead of omitted from chapter or scene batches", () => {
  const options = fixture([["text", "Preamble."], ["chapter", "One"], ["text", "Hello."]]);
  assert.throws(() => planSpeechExportGroups(options), /inside a chapter/u);
  const chapterOnly = fixture([["chapter", "One"], ["text", "Hello."]]);
  chapterOnly.groupBy = "scene";
  assert.throws(() => planSpeechExportGroups(chapterOnly), /entirely inside a scene/u);
});

test("scene attribution rejects missing source maps and ranges spanning scope boundaries", () => {
  const options = fixture([
    ["scene", "First"],
    ["text", "Hello."],
    ["scene", "Second"],
    ["text", "Goodbye."],
  ]);
  options.groupBy = "scene";
  const first = options.compiled.segments[0]!;
  const second = options.compiled.segments[1]!;
  const firstMap = first.sourceMap;
  first.sourceMap = [];
  assert.throws(() => planSpeechExportGroups(options), /no scene source map/u);
  first.sourceMap = [firstMap[0]!, second.sourceMap[0]!];
  assert.throws(() => planSpeechExportGroups(options), /multiple scenes/u);
  first.sourceMap = [{ ...firstMap[0]!, to: second.sourceMap[0]!.to }];
  assert.throws(() => planSpeechExportGroups(options), /entirely inside a scene/u);
});

test("filenames are ordered, bounded, safe, and distinct for duplicate or hostile titles", () => {
  const options = fixture([
    ["chapter", "CON"],
    ["text", "First."],
    ["chapter", "con"],
    ["text", "Second."],
    ["chapter", "CON"],
    ["text", "Third."],
    ["chapter", ".. /\\<>:\"|?*\u0000\u202e " + "😀".repeat(100)],
    ["text", "Fourth."],
  ]);
  const groups = planSpeechExportGroups(options);
  const filenames = groups.map(group => group.request.outputPath.slice(options.outputDirectory.length + 1));
  assert.equal(new Set(filenames.map(name => name.toLowerCase())).size, 4);
  for (const [index, filename] of filenames.entries()) {
    assert.equal(filename.startsWith(String(index + 1).padStart(3, "0") + "-chapter-"), true);
    assert.equal(/[\p{Cc}\p{Cf}<>:"/\\|?*]/u.test(filename), false);
    assert.ok(new TextEncoder().encode(filename).length <= 255);
    assert.equal(/[ .]$/u.test(filename), false);
  }
  const otherProject = structuredClone(options);
  otherProject.project.id = "other-project";
  for (const take of otherProject.takes) take.projectId = otherProject.project.id;
  assert.notEqual(planSpeechExportGroups(otherProject)[0]!.request.outputPath, groups[0]!.request.outputPath);
});

test("export requests preserve the preset and overwrite choice for every group-capable format", () => {
  const options = fixture([["chapter", "One"], ["text", "Hello."]]);
  options.overwrite = true;
  for (const format of ["wav", "mp3", "opus", "flac", "m4b", "srt", "vtt", "txt", "json"] as const) {
    options.settings = {
      format,
      sampleRate: 44100,
      channels: 1,
      bitrate: 96000,
      loudnessLufs: -20,
      truePeakDb: -3,
    };
    const request = planSpeechExportGroups(options)[0]!.request;
    assert.deepEqual(request, {
      ...options.settings,
      projectId: options.project.id,
      revisionId: options.project.revisionId,
      takeIds: ["take-1"],
      outputPath: request.outputPath,
      overwrite: true,
      includeBackground: false,
    });
    assert.equal(request.outputPath.endsWith("." + format), true);
  }
});

test("output paths support Windows and WSL directories including roots without extra separators", () => {
  const options = fixture([["chapter", "One"], ["text", "Hello."]]);
  for (const [directory, prefix] of [
    ["D:\\Exports\\", "D:\\Exports\\"],
    ["D:\\", "D:\\"],
    ["/mnt/d/Exports/", "/mnt/d/Exports/"],
    ["/", "/"],
  ]) {
    options.outputDirectory = directory!;
    assert.equal(planSpeechExportGroups(options)[0]!.request.outputPath.startsWith(prefix! + "001-"), true);
  }
});

test("portable archives, invalid presets, and invalid directories fail before producing requests", () => {
  const options = fixture([["chapter", "One"], ["text", "Hello."]]);
  options.settings.format = "archive";
  assert.throws(() => planSpeechExportGroups(options), /complete project separately/u);
  options.settings = { ...DEFAULT_SPEECH_EXPORT, sampleRate: 100 };
  assert.throws(() => planSpeechExportGroups(options), /sample rate/u);
  options.settings = { ...DEFAULT_SPEECH_EXPORT };
  for (const directory of ["", "  ", "D:\\Exports\u0000", "D:\\Exports\n", "D:\\Exports\u202e"]) {
    options.outputDirectory = directory;
    assert.throws(() => planSpeechExportGroups(options), /export directory/u);
  }
});
