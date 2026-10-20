import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpeechCastBinding } from "./compiler.ts";
import type { SpeechCastMember } from "./runtime.ts";
import { parseSpeechScript } from "./script.ts";
import {
  collectSpeechReferenceAssetIds,
  resolveSpeechSceneBinding,
  validateSpeechProjectCast,
  type SpeechSceneBindingOverride,
  type SpeechSceneOverride,
} from "./scene-casting.ts";

const source = "# Chapter one\n## Scene one\nHello.\n## Scene two\nGoodbye.\n# Chapter two\n## Scene three\nAgain.";
const scopes = parseSpeechScript(source).nodes
  .filter(node => node.kind === "chapter" || node.kind === "scene");
const [chapterOne, sceneOne, sceneTwo, chapterTwo, sceneThree] = scopes.map(node => node.id) as [string, string, string, string, string];

type CastMember = SpeechCastMember & { sceneOverrides?: SpeechSceneOverride[] };
type CastBinding = SpeechCastBinding & { sceneOverrides?: SpeechSceneBindingOverride[] };

function member(overrides: SpeechSceneOverride[] = []): CastMember {
  return {
    id: "narrator", name: "Narrator", voiceId: "base-voice",
    referenceAssetIds: [], direction: "measured", sceneOverrides: overrides,
  };
}

function binding(): CastBinding {
  return {
    id: "narrator", name: "Narrator", voiceId: "base-voice",
    direction: "measured",
    sceneOverrides: [
      { sceneId: sceneOne, referenceHashes: ["scene-hash"], direction: "" },
      { sceneId: chapterOne, voiceId: "chapter-voice", direction: "soft" },
    ],
  };
}

test("scene bindings take precedence over chapter bindings regardless of list order", () => {
  for (const reverse of [false, true]) {
    const cast = binding();
    if (reverse) cast.sceneOverrides!.reverse();
    const resolved = resolveSpeechSceneBinding(cast, [chapterOne, sceneOne]);
    assert.equal(resolved.voiceId, undefined);
    assert.deepEqual(resolved.referenceHashes, ["scene-hash"]);
    assert.equal(resolved.direction, "");
    assert.equal(resolved.id, cast.id);
    assert.equal(resolved.name, cast.name);
    const chapter = resolveSpeechSceneBinding(cast, [chapterOne, sceneTwo]);
    assert.equal(chapter.voiceId, "chapter-voice");
    assert.equal(chapter.referenceHashes, undefined);
    assert.equal(chapter.direction, "soft");
  }
});

test("a scene binding works without a chapter and empty scopes keep the base object", () => {
  const cast = binding();
  assert.deepEqual(resolveSpeechSceneBinding(cast, [null, sceneOne]).referenceHashes, ["scene-hash"]);
  assert.strictEqual(resolveSpeechSceneBinding(cast, [undefined, undefined]), cast);
  assert.strictEqual(resolveSpeechSceneBinding(cast, [chapterTwo, sceneThree]), cast);
  const base: SpeechCastBinding = { id: "a", name: "A", voiceId: "voice" };
  assert.strictEqual(resolveSpeechSceneBinding(base, [chapterOne, sceneOne]), base);
});

test("leaving a scene restores the chapter binding and leaving the chapter restores defaults", () => {
  const cast = binding();
  assert.equal(resolveSpeechSceneBinding(cast, [chapterOne, sceneOne]).voiceId, undefined);
  assert.equal(resolveSpeechSceneBinding(cast, [chapterOne, sceneTwo]).voiceId, "chapter-voice");
  assert.strictEqual(resolveSpeechSceneBinding(cast, [chapterTwo, sceneThree]), cast);
  assert.equal(cast.voiceId, "base-voice");
});

test("voice and reference overrides replace every synthesis field without mutating inputs", () => {
  const cast: CastBinding = {
    id: "narrator", name: "Narrator", referenceHashes: ["base-hash"], direction: "base",
    sceneOverrides: [
      { sceneId: chapterOne, referenceHashes: ["chapter-hash"], direction: "chapter" },
      { sceneId: sceneOne, voiceId: "scene-voice", direction: "" },
    ],
  };
  const before = structuredClone(cast);
  for (const override of cast.sceneOverrides!) {
    if (override.referenceHashes) Object.freeze(override.referenceHashes);
    Object.freeze(override);
  }
  Object.freeze(cast.referenceHashes);
  Object.freeze(cast.sceneOverrides);
  Object.freeze(cast);
  const resolved = resolveSpeechSceneBinding(cast, [chapterOne, sceneOne]);
  assert.equal(resolved.voiceId, "scene-voice");
  assert.equal(resolved.referenceHashes, undefined);
  assert.equal(resolved.direction, "");
  const chapter = resolveSpeechSceneBinding(cast, [chapterOne, sceneTwo]);
  assert.equal(chapter.voiceId, undefined);
  assert.deepEqual(chapter.referenceHashes, ["chapter-hash"]);
  chapter.referenceHashes!.push("output-only");
  resolved.voiceId = "output-only";
  assert.deepEqual(cast, before);
});

test("an explicitly unassigned override never inherits a default voice or references", () => {
  const cast = binding();
  cast.sceneOverrides = [{ sceneId: sceneOne, direction: "" }];
  const resolved = resolveSpeechSceneBinding(cast, [chapterOne, sceneOne]);
  assert.equal(resolved.voiceId, undefined);
  assert.equal(resolved.referenceHashes, undefined);
  assert.equal(resolved.direction, "");
});

test("reference collection includes inactive overrides and deduplicates IDs in first-use order", () => {
  const cast: CastMember[] = [
    { ...member(), voiceId: undefined, referenceAssetIds: ["base", "shared"], sceneOverrides: [
      { sceneId: chapterOne, referenceAssetIds: ["shared", "chapter"], direction: "" },
      { sceneId: sceneOne, referenceAssetIds: ["scene", "base"], direction: "" },
    ] },
    { ...member(), id: "other", voiceId: undefined, referenceAssetIds: ["scene", "other"] },
  ];
  const before = structuredClone(cast);
  const ids = collectSpeechReferenceAssetIds(cast);
  assert.deepEqual(ids, ["base", "shared", "chapter", "scene", "other"]);
  ids.push("output-only");
  assert.deepEqual(cast, before);
  assert.deepEqual(collectSpeechReferenceAssetIds([]), []);
  assert.deepEqual(collectSpeechReferenceAssetIds([{ ...member(), sceneOverrides: undefined }]), []);
});

test("project asset IDs stay distinct from content hashes used by scene bindings", () => {
  const override: SpeechSceneOverride = {
    sceneId: sceneOne, referenceAssetIds: ["reference-a", "reference-b"], direction: "quiet",
    rightsEvidence: "Owner permission",
  };
  const cast = member([override]);
  const hashes = new Map([["reference-a", "sha-a"], ["reference-b", "sha-b"]]);
  const compiled: CastBinding = {
    id: cast.id, name: cast.name, voiceId: cast.voiceId, direction: cast.direction,
    sceneOverrides: cast.sceneOverrides!.map(value => ({
      sceneId: value.sceneId, voiceId: value.voiceId,
      referenceHashes: value.referenceAssetIds.map(id => hashes.get(id)!),
      direction: value.direction,
    })),
  };
  assert.deepEqual(collectSpeechReferenceAssetIds([cast]), ["reference-a", "reference-b"]);
  assert.deepEqual(resolveSpeechSceneBinding(compiled, [chapterOne, sceneOne]).referenceHashes, ["sha-a", "sha-b"]);
  assert.deepEqual(override.referenceAssetIds, ["reference-a", "reference-b"]);
});

test("project validation accepts chapter and scene scopes shared by different cast members", () => {
  const overrides: SpeechSceneOverride[] = [
    { sceneId: chapterOne, voiceId: "chapter-voice", referenceAssetIds: [], direction: "" },
    { sceneId: sceneOne, referenceAssetIds: ["reference"], direction: "whisper" },
  ];
  const cast = [member(overrides), { ...member(overrides), id: "other" }];
  const project = { source, cast };
  const before = structuredClone(project);
  assert.doesNotThrow(() => validateSpeechProjectCast(project, new Map([
    ["reference", { rightsEvidence: "Recorded owner permission" }],
  ])));
  assert.deepEqual(project, before);
  assert.doesNotThrow(() => validateSpeechProjectCast({ source, cast: [] }, new Map()));
});

test("project validation rejects duplicate, blank, unknown and nonstructural scope IDs", () => {
  const textId = parseSpeechScript(source).nodes.find(node => node.kind === "text")!.id;
  for (const sceneId of ["", " ", "unknown", textId, null, 42]) {
    const override = { sceneId, voiceId: "voice", referenceAssetIds: [], direction: "" } as unknown as SpeechSceneOverride;
    assert.throws(() => validateSpeechProjectCast({ source, cast: [member([override])] }, new Map()), /scope/i);
  }
  const override: SpeechSceneOverride = { sceneId: sceneOne, voiceId: "voice", referenceAssetIds: [], direction: "" };
  assert.throws(() => validateSpeechProjectCast({ source, cast: [member([override, { ...override }])] }, new Map()), /unique/i);
  assert.throws(() => validateSpeechProjectCast({ source, cast: [member(), member()] }, new Map()), /Cast IDs must be unique/);
});

test("project validation rejects ambiguous voice and reference bindings in defaults and overrides", () => {
  const references = new Map([["reference", { rightsEvidence: "Permission" }]]);
  assert.throws(() => validateSpeechProjectCast({
    source, cast: [{ ...member(), referenceAssetIds: ["reference"] }],
  }, references), /either a voice ID or reference/);
  assert.throws(() => validateSpeechProjectCast({
    source, cast: [member([{ sceneId: sceneOne, voiceId: "voice", referenceAssetIds: ["reference"], direction: "" }])],
  }, references), /either a voice ID or reference/);
});

test("project validation checks binding IDs, reference arrays, direction types and control delimiters", () => {
  const invalid = [
    { voiceId: "" }, { voiceId: " " }, { voiceId: 3 }, { voiceId: null },
    { referenceAssetIds: null }, { referenceAssetIds: "reference" },
    { voiceId: undefined, referenceAssetIds: [""] },
    { voiceId: undefined, referenceAssetIds: [null] },
    { voiceId: undefined, referenceAssetIds: [42] },
    { voiceId: undefined, referenceAssetIds: Array(1) },
    { direction: undefined }, { direction: null }, { direction: 3 },
    { direction: "[soft]" }, { direction: "<soft>" }, { direction: "two\nlines" },
    { direction: "two\rlines" }, { rightsEvidence: " " }, { rightsEvidence: 3 },
  ];
  for (const patch of invalid) {
    const cast = { ...member(), ...patch } as unknown as CastMember;
    assert.throws(() => validateSpeechProjectCast({ source, cast: [cast] }, new Map()));
    const override = {
      sceneId: sceneOne, voiceId: "voice", referenceAssetIds: [], direction: "", ...patch,
    } as unknown as SpeechSceneOverride;
    assert.throws(() => validateSpeechProjectCast({ source, cast: [member([override])] }, new Map()));
  }
  for (const id of ["", " ", null, 42]) {
    assert.throws(() => validateSpeechProjectCast({
      source, cast: [{ ...member(), id } as unknown as CastMember],
    }, new Map()), /Cast ID/);
  }
});

test("project validation rejects malformed project, cast and override containers", () => {
  for (const project of [null, {}, { source, cast: null }, { source: 3, cast: [] },
    { source, cast: [null] }, { source, cast: [member(null as unknown as SpeechSceneOverride[])] },
    { source, cast: [member([null as unknown as SpeechSceneOverride])] },
  ]) {
    assert.throws(() => validateSpeechProjectCast(
      project as unknown as Parameters<typeof validateSpeechProjectCast>[0], new Map(),
    ));
  }
});

test("project validation requires available reference assets and their own permission evidence", () => {
  const reference: SpeechSceneOverride = {
    sceneId: sceneOne, referenceAssetIds: ["reference"], direction: "",
    rightsEvidence: "Cast metadata cannot replace asset permission",
  };
  for (const cast of [
    [member([reference])],
    [{ ...member(), voiceId: undefined, referenceAssetIds: ["reference"], rightsEvidence: "Cast permission" }],
  ]) {
    assert.throws(() => validateSpeechProjectCast({ source, cast }, new Map()), /unavailable/);
    for (const rightsEvidence of ["", " ", null, 42, undefined]) {
      const references = new Map([["reference", { rightsEvidence }]]) as unknown as Map<string, { rightsEvidence: string }>;
      assert.throws(() => validateSpeechProjectCast({ source, cast }, references), /permission or rights evidence/);
    }
    assert.doesNotThrow(() => validateSpeechProjectCast({ source, cast }, new Map([
      ["reference", { rightsEvidence: "Recorded permission" }],
    ])));
  }
});
