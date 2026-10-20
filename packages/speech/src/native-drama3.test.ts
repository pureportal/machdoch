import test from "node:test";
import assert from "node:assert/strict";
import { estimateSpeechRender } from "./pricing.ts";
import { speechProfileBinding } from "./profile-binding.ts";
import { prepareSpeechBatch, submitSpeechBatch } from "./batch.ts";
import type { SpeechProfile, SpeechRuntime } from "./runtime.ts";

const profile: SpeechProfile = {
  id: "local", name: "Drama 3 local", backend: "drama3", model: "drama-3", direction: "",
  temperature: 0.7, topP: 0.7, chunkLength: 300, minChunkLength: 50, latency: "normal", dictionaryIds: [], playbackRate: 1,
};

test("local Drama 3 has no cloud charge and accepts optional voice recordings", () => {
  assert.equal(estimateSpeechRender(["Hello."], profile, 1, null).amount, 0);
  assert.deepEqual(speechProfileBinding(profile), { voiceIds: [], referenceAssetIds: [] });
  assert.deepEqual(speechProfileBinding({ ...profile, referenceAssetIds: ["reference"] }), { voiceIds: [], referenceAssetIds: ["reference"] });
});

test("local batches can be submitted without cloud consent or account pricing", async () => {
  const prepared = prepareSpeechBatch([{ id: "one", name: "Local.txt", source: "Hello from Drama Three.", format: "text" }], {
    compile: { backend: "drama3", cast: [] }, profile, pricing: null, takes: 1, cast: [], stripMetadata: false, mappings: {}, bindings: {},
  });
  const calls: string[] = [];
  const runtime = { transport: "native", execute: async (operation: string, input: { project?: object }) => {
    calls.push(operation);
    return operation === "saveProject" ? { ...input.project, revisionId: "revision" } : { id: "job", state: "queued" };
  } } as SpeechRuntime;
  const receipt = await submitSpeechBatch(runtime, prepared, {
    id: "batch", profile, cast: [], takes: 1, cloudConsent: false, budgetLimit: 0, dictionaryRevisions: [], signal: new AbortController().signal, onProgress() {},
  });
  assert.deepEqual(calls, ["saveProject", "render"]);
  assert.equal(receipt.items[0]!.state, "queued");
});
