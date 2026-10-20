import test from "node:test";
import assert from "node:assert/strict";
import { parseSpeechScript, serializeSpeechScript, validatePhonemes } from "./script.ts";
import { compileSpeechScript, speechContentHash } from "./compiler.ts";
import { AnswerSpeechLedger, IncrementalAnswerSpeech, markdownToSpeech, type FinalAnswerEvent } from "./answer.ts";
import { previewPronunciation, validateDictionaries } from "./dictionary.ts";
import { SpeechAlignment, exportSubtitles } from "./alignment.ts";
import { SpeechPlaybackCoordinator, type PlaybackHandle, type PlaybackState } from "./playback.ts";

const cast = [{ id: "alix", name: "Alix", voiceId: "voice-alix" }, { id: "bo", name: "Bo", voiceId: "voice-bo" }];

test("script round-trip preserves Unicode, editorial metadata and free-form direction", () => {
  const source = "# Kapitel 東京\n<!-- not spoken -->\n<|speaker:alix|>[uneasy, while opening a heavy door] مرحبا <soft>世界</soft> 👩🏽‍🚀\n";
  const parsed = parseSpeechScript(source);
  assert.equal(serializeSpeechScript(parsed), source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.utf8Bytes, new TextEncoder().encode(source).length);
  const compiled = compileSpeechScript(parsed, { cast });
  assert.deepEqual(compiled.diagnostics, []);
  assert.doesNotMatch(compiled.segments[0].text, /Kapitel|not spoken|alix/u);
  assert.match(compiled.segments[0].text, /^<\|speaker:0\|>/u);
});

test("crossed scopes, unsupported markup and invalid phonemes are blocking diagnostics", () => {
  for (const source of ["<soft><fast>x</soft></fast>", "[unfinished", "<unknown>x</unknown>", "a ] b", "<|phoneme_end|>", "<soft>x"]) {
    assert.ok(parseSpeechScript(source).diagnostics.some(item => item.severity === "error"), source);
    assert.equal(compileSpeechScript(source, { cast }).segments.length, 0, source);
  }
  assert.equal(validatePhonemes("HH AH0 L OW1", "arpabet"), true);
  assert.equal(validatePhonemes("S1", "arpabet"), false);
  assert.equal(validatePhonemes("həˈləʊ", "arpabet"), false);
  assert.ok(parseSpeechScript("<|phoneme_start|>fake<|phoneme_end|>", { phonemeAlphabet: "arpabet" }).diagnostics.length);
});

test("cast indices are contiguous per segment and stable IDs survive reordering", () => {
  const source = "<|speaker:bo|>Hello.\n<|speaker:alix|>Hi.\n";
  const first = compileSpeechScript(source, { cast });
  const reordered = compileSpeechScript(source, { cast: [...cast].reverse() });
  assert.deepEqual(first.segments, reordered.segments);
  assert.match(first.segments[0].text, /^<\|speaker:0\|>Hello\.\n<\|speaker:1\|>Hi/u);
  assert.equal(compileSpeechScript("<|speaker:missing|>x", { cast }).segments.length, 0);
  assert.equal(compileSpeechScript("x", { cast: [{ id: "x", name: "x" }] }).segments.length, 0);
});

test("segmentation keeps delivery scopes, phonemes and Unicode intact", () => {
  const source = "<|speaker:alix|>A paragraph.\nAnother paragraph.\n<soft>世界. 👩🏽‍🚀</soft>\n";
  const compiled = compileSpeechScript(source, { cast, maxUtf8Bytes: 65 });
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(compiled.segments.length >= 2);
  for (const segment of compiled.segments) {
    assert.ok(segment.utf8Bytes <= 65);
    assert.deepEqual(parseSpeechScript(segment.text).diagnostics, []);
  }
  assert.equal(compiled.segments.map(segment => segment.text).join("").match(/Another paragraph/gu)?.length, 1);
});

test("selection preview retains speaker and enclosing delivery", () => {
  const source = "<|speaker:bo|><soft>Hello world.</soft>";
  const from = source.indexOf("Hello");
  const compiled = compileSpeechScript(source, { cast, selection: { from, to: from + 5 } });
  assert.equal(compiled.segments[0]?.text, "<|speaker:0|><soft>Hello</soft>");
  assert.equal(compiled.segments[0]?.speakers[0].id, "bo");
});

test("hash includes full reference and generation provenance with canonical object ordering", async () => {
  assert.equal(await speechContentHash({ text: "hello", settings: { b: 2, a: 1 } }), await speechContentHash({ settings: { a: 1, b: 2 }, text: "hello" }));
  assert.notEqual(await speechContentHash({ voice: "1" }), await speechContentHash({ voice: "2" }));
});

test("Markdown AST speaks labels and table headers without code, HTML or control injection", () => {
  const speech = markdownToSpeech("# Results\n\n[Fish](https://secret.invalid)\n\n| Name | Value |\n| --- | --- |\n| One | Two |\n\n```mermaid\ngraph TD; hidden-->secret\n```\n\n`private code` <script>internal</script> [calm] <|speaker:9|>");
  assert.match(speech, /Results.*Fish.*Name: One; Value: Two/u);
  assert.doesNotMatch(speech, /secret\.invalid|graph TD|private code|[<>[\]]/u);
  assert.match(speech, /Diagram omitted/u);
  assert.match(markdownToSpeech("`printf hello`", { readCode: true }), /printf hello/u);
});

const event = (markdown: string, complete = false, revision = "r1"): FinalAnswerEvent => ({ kind: "answer", channel: "final", audience: "user", sessionId: "s", answerId: "a", revision, markdown, complete });

test("incremental answer speech handles control markup split across token boundaries", () => {
  const stream = new IncrementalAnswerSpeech();
  assert.deepEqual(stream.update({ ...event("never"), channel: "analysis" }).segments, []);
  assert.equal(stream.update(event("A safe sentence. ")).segments[0]?.text, "A safe sentence.");
  assert.deepEqual(stream.update(event("A safe sentence. <|spea")).segments, []);
  const final = stream.update(event("A safe sentence. <|speaker:9|>[angry] Hello.", true));
  assert.equal(final.segments.length, 1);
  assert.doesNotMatch(final.segments[0].text, /[<>[\]]/u);
  assert.deepEqual(stream.update(event("A safe sentence. <|speaker:9|>[angry] Hello.", true)).segments, []);
});

test("incomplete links, tags and entities are not spoken and fences wait for completion", () => {
  for (const source of ["[A sentence. ", "<|speaker:0", "&dangling"]) {
    const stream = new IncrementalAnswerSpeech();
    assert.deepEqual(stream.update(event(source, true)).segments, [], source);
  }
  const stream = new IncrementalAnswerSpeech();
  assert.deepEqual(stream.update(event("```js\nhidden.\n")).segments, []);
  assert.doesNotMatch(stream.update(event("```js\nhidden.\n```\nSafe. ", true)).segments[0].text, /hidden/u);
});

test("answer revisions stop automatic continuation and reconnect duplicates are ignored", () => {
  const stream = new IncrementalAnswerSpeech();
  stream.update(event("Original. "));
  assert.equal(stream.update(event("Corrected. ", false, "r2")).replaced, true);
  assert.deepEqual(stream.update(event("Corrected. More. ", true, "r2")).segments, []);
  const ledger = new AnswerSpeechLedger(2);
  ledger.prime([event("old", true)]);
  assert.equal(ledger.accept(event("old", true)), "duplicate");
  assert.equal(ledger.accept(event("new", true, "r2")), "revised");
  assert.equal(ledger.accept({ ...event("new", true), answerId: "b" }), "new");
});

test("dictionaries use literal leftmost-longest matching and preserve pinned revisions", () => {
  const dictionary = { id: "dict", revision: "r1", name: "Terms", rules: [
    { id: "short", text: "Mach", phonemes: "M AA1 K", alphabet: "arpabet" as const, caseSensitive: true },
    { id: "long", text: "Machdoch", phonemes: "M AA1 K D AA1 K", alphabet: "arpabet" as const, caseSensitive: true },
  ] };
  assert.deepEqual(validateDictionaries([dictionary]), []);
  const preview = previewPronunciation("Machdoch Mach", [dictionary]);
  assert.deepEqual(preview.map(value => value.ruleId), ["long", "short"]);
  assert.equal(preview[0].revision, "r1");
  assert.ok(validateDictionaries([{ ...dictionary, rules: [...dictionary.rules, { ...dictionary.rules[0], id: "conflict", phonemes: "M IY1" }] }]).length);
});

test("alignment snapshots replace cumulative chunks and apply measured offsets", () => {
  const alignment = new SpeechAlignment();
  alignment.replace({ chunkSeq: 0, chunkAudioOffsetSeconds: 0, words: [{ text: "Hello", start: 0, end: 0.5 }] });
  alignment.replace({ chunkSeq: 0, chunkAudioOffsetSeconds: 0, words: [{ text: "Hello", start: 0, end: 0.6 }, { text: "world", start: 0.6, end: 1 }] });
  alignment.replace({ chunkSeq: 1, chunkAudioOffsetSeconds: 2, words: [{ text: "Again", start: 0.1, end: 0.5 }] });
  assert.equal(alignment.words().length, 3);
  assert.equal(alignment.words()[2].start, 2.1);
  assert.match(exportSubtitles(alignment.words(), "srt"), /00:00:02,100 --> 00:00:02,500/u);
  assert.throws(() => exportSubtitles([], "vtt"), /Measured alignment/u);
  assert.throws(() => alignment.replace({ chunkSeq: 2, chunkAudioOffsetSeconds: NaN, words: [] }));
});

test("foreground replacement aborts prior playback and rejects late audio", async () => {
  const coordinator = new SpeechPlaybackCoordinator();
  let stopped = false;
  let oldSignal: AbortSignal | undefined;
  let resolveOld: ((handle: PlaybackHandle) => void) | undefined;
  const lateHandle: PlaybackHandle = { play: async () => { throw new Error("obsolete audio played"); }, pause() {}, stop: () => { stopped = true; }, seek() {}, setRate() {}, setVolume() {}, onState: () => () => {} };
  const old = coordinator.play({ owner: "chat", itemId: "a", open: signal => { oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; }); } });
  const current: PlaybackHandle = { ...lateHandle, play: async () => {}, stop() {} };
  await coordinator.play({ owner: "tts", itemId: "b", open: async () => current });
  assert.equal(oldSignal?.aborted, true);
  resolveOld!(lateHandle);
  await old;
  assert.equal(stopped, true);
  assert.equal(coordinator.snapshot().itemId, "b");
  coordinator.stop("chat");
  assert.equal(coordinator.snapshot().status, "playing");
  coordinator.stop();
});

test("autoplay failures keep the completed handle for explicit resume", async () => {
  const coordinator = new SpeechPlaybackCoordinator();
  let calls = 0;
  const handle: PlaybackHandle = { play: async () => { if (calls++ === 0) throw new DOMException("blocked", "NotAllowedError"); }, pause() {}, stop() {}, seek() {}, setRate() {}, setVolume() {}, onState: (_listener: (state: Partial<PlaybackState>) => void) => () => {} };
  await coordinator.play({ owner: "chat", itemId: "answer", open: async () => handle });
  assert.equal(coordinator.snapshot().status, "blocked");
  await coordinator.resume();
  assert.equal(coordinator.snapshot().status, "playing");
  assert.equal(calls, 2);
});

test("recording pauses audio that is still loading and resume uses the same render", async () => {
  const coordinator = new SpeechPlaybackCoordinator();
  let open: ((handle: PlaybackHandle) => void) | undefined;
  let plays = 0;
  const handle: PlaybackHandle = {play:async()=>{plays++;},pause(){},stop(){},seek(){},setRate(){},setVolume(){},onState:()=>()=>{}};
  const loading = coordinator.play({owner:"chat",itemId:"answer",open:()=>new Promise(resolve=>{open=resolve;})});
  coordinator.pause();
  open!(handle);
  await loading;
  assert.equal(plays,0);
  assert.equal(coordinator.snapshot().status,"paused");
  await coordinator.resume();
  assert.equal(plays,1);
});

test("a late resume failure cannot overwrite a replacement foreground item", async () => {
  const coordinator = new SpeechPlaybackCoordinator();
  let reject: ((reason: Error) => void) | undefined;
  let plays=0;
  const handle: PlaybackHandle={play:async()=>{if(plays++)await new Promise<void>((_,fail)=>{reject=fail;});},pause(){},stop(){},seek(){},setRate(){},setVolume(){},onState:()=>()=>{}};
  await coordinator.play({owner:"chat",itemId:"old",open:async()=>handle});
  coordinator.pause();
  const resuming=coordinator.resume();
  await coordinator.play({owner:"studio",itemId:"new",open:async()=>({...handle,play:async()=>{}})});
  reject!(new Error("Old device failed"));
  await resuming;
  assert.equal(coordinator.snapshot().itemId,"new");
  assert.equal(coordinator.snapshot().status,"playing");
  assert.equal(coordinator.snapshot().error,null);
});
