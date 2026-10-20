import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSpeechScript } from "./compiler.ts";
import { parseSpeechScript } from "./script.ts";
import { speechCastBindings } from "./scene-casting.ts";
import type { SpeechCastMember } from "./runtime.ts";

test("chapter/scene overrides compile to actual bindings, selection retains scopes, and unrelated segments remain stable", () => {
  const source =
    "# One\n<|speaker:n|>Chapter words.\n## Quiet\n<|speaker:n|>Scene words.\n## Default\nMore words.\n# Two\nFinal words.";
  const script = parseSpeechScript(source);
  const scopes = script.nodes.filter(
    (node) => node.kind === "scene" || node.kind === "chapter",
  );
  const cast: SpeechCastMember[] = [
    {
      id: "n",
      name: "Narrator",
      voiceId: "base",
      referenceAssetIds: [],
      direction: "",
      sceneOverrides: [
        {
          sceneId: scopes[0]!.id,
          voiceId: "chapter",
          referenceAssetIds: [],
          direction: "measured",
        },
        {
          sceneId: scopes[1]!.id,
          referenceAssetIds: ["ref"],
          direction: "quiet",
        },
      ],
    },
  ];
  const options = { cast: speechCastBindings(cast, (id) => id) };
  const result = compileSpeechScript(source, options);
  assert.deepEqual(
    result.diagnostics.filter((item) => item.severity === "error"),
    [],
  );
  assert.deepEqual(
    result.segments.map((segment) => segment.speakers[0]!.voiceId),
    ["chapter", undefined, "chapter", "base"],
  );
  assert.deepEqual(result.segments[1]!.speakers[0]!.referenceHashes, ["ref"]);
  const from = source.indexOf("Scene words.");
  const selected = compileSpeechScript(source, {
    ...options,
    selection: { from, to: from + "Scene words.".length },
  });
  assert.deepEqual(
    selected.diagnostics.filter((item) => item.severity === "error"),
    [],
  );
  assert.deepEqual(selected.segments[0]!.speakers[0]!.referenceHashes, ["ref"]);
  assert.ok(selected.segments[0]!.text.includes("[quiet]"));
  const changed = structuredClone(cast);
  changed[0]!.sceneOverrides![1]!.direction = "whisper";
  const next = compileSpeechScript(source, {
    cast: speechCastBindings(changed, (id) => id),
  });
  assert.equal(result.segments[0]!.id, next.segments[0]!.id);
  assert.notEqual(result.segments[1]!.id, next.segments[1]!.id);
  assert.equal(result.segments[2]!.id, next.segments[2]!.id);
  assert.equal(result.segments[3]!.id, next.segments[3]!.id);
  assert.equal(result.script.source, source);
});
