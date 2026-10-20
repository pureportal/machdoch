import assert from "node:assert/strict";
import { test } from "node:test";
import {
  copyProjectVariant,
  createProjectVariant,
  importDialogue,
  importSpeechDocument,
  parseDialogueTable,
  parseSpeechTemplate,
  readingSentences,
  resolveSpeechTemplate,
  updateProjectVariant,
  validateSpeechTemplate,
} from "./imports.ts";
import type { SpeechProject } from "./runtime";

function project(): SpeechProject {
  return {
    id: "project",
    title: "Original",
    source: "# 第一章\r\n<|speaker:cast-a|>你好，世界！ 👩🏽‍🚀\r\nGuten Tag.",
    cast: [{ id: "cast-a", name: "Narrator", referenceAssetIds: [], direction: "" }],
    profileId: null,
    revisionId: "revision",
    parentRevisionId: null,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    archived: false,
    location: null,
    timeline: [],
    selectedTakes: {},
    bookmarks: [{ id: "bookmark", label: "开头", offset: 0 }],
    variants: [],
  };
}

test("CSV preserves quoted commas, doubled quotes, embedded CRLF, and original source", () => {
  const source = '\uFEFFspeaker,text\r\n"Ada","Hello, ""world""!\r\nAnother line."\r\n"李","你好！"\r\n';
  const parsed = parseDialogueTable(source, ",");
  assert.equal(parsed.source, source);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.rows, [
    ["speaker", "text"],
    ["Ada", 'Hello, "world"!\r\nAnother line.'],
    ["李", "你好！"],
  ]);
});

test("TSV supports quoted tabs and newlines without fabricating a trailing row", () => {
  const source = 'speaker\ttext\nAda\t"one\ttwo\nthree"\n李\t你好\n';
  const parsed = parseDialogueTable(source, "\t");
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.rows, [["speaker", "text"], ["Ada", "one\ttwo\nthree"], ["李", "你好"]]);
  assert.deepEqual(parseDialogueTable("", ",").rows, []);
  assert.deepEqual(parseDialogueTable('""', ",").rows, [[""]]);
  assert.deepEqual(parseDialogueTable("a,b,", ",").rows, [["a", "b", ""]]);
  assert.deepEqual(parseDialogueTable("\n", ",").rows, [[""]]);
});

test("malformed tables report quote and column diagnostics with valid source offsets", () => {
  for (const [source, code] of [
    ['speaker,text\nAda,"Unclosed', "unclosed-quote"],
    ['speaker,text\nAda,"Hello"x', "characters-after-quote"],
    ['speaker,text\nAda,Un"quoted', "unexpected-quote"],
    ["speaker,text\nAda", "column-count"],
  ]) {
    const parsed = parseDialogueTable(source, ",");
    assert.ok(parsed.diagnostics.some(diagnostic => diagnostic.code === code));
    assert.ok(parsed.diagnostics.every(diagnostic => diagnostic.from >= 0 && diagnostic.to <= source.length));
  }
});

test("dialogue requires explicit columns and maps names to stable cast IDs", () => {
  const parsed = parseDialogueTable('line,role\n"Hello, there",Ada\n你好,李', ",");
  const imported = importDialogue(parsed.rows.slice(1), {
    textColumn: 0,
    speakerColumn: 1,
    castBindings: { Ada: "cast-7", 李: "cast-2" },
  });
  assert.deepEqual(imported.diagnostics, []);
  assert.equal(imported.source, "<|speaker:cast-7|>Hello, there\n<|speaker:cast-2|>你好");
});

test("dialogue rejects missing cast bindings, missing columns, and invented control IDs", () => {
  const rows = [["Ada", "Hello"], ["李", "你好"]];
  const missing = importDialogue(rows, { textColumn: 1, speakerColumn: 0, castBindings: { Ada: "cast-7" } });
  assert.equal(missing.source, "");
  assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === "missing-cast"));
  assert.ok(importDialogue(rows, { textColumn: 0, speakerColumn: 0, castBindings: {} }).diagnostics.some(diagnostic => diagnostic.code === "column-mapping"));
  assert.ok(importDialogue([["Ada"]], { textColumn: 1, speakerColumn: 0, castBindings: {} }).diagnostics.some(diagnostic => diagnostic.code === "missing-column"));
  assert.ok(importDialogue([["Ada", "Hello"]], { textColumn: 1, speakerColumn: 0, castBindings: { Ada: "x|>[angry]" } }).diagnostics.some(diagnostic => diagnostic.code === "invalid-cast-id"));
  assert.ok(importDialogue([["Ada", "[angry]Hello"]], { textColumn: 1, speakerColumn: 0, castBindings: { Ada: "cast-7" } }).diagnostics.some(diagnostic => diagnostic.code === "dialogue-controls"));
  assert.ok(importDialogue([["toString", "Hello"]], { textColumn: 1, speakerColumn: 0, castBindings: {} }).diagnostics.some(diagnostic => diagnostic.code === "missing-cast"));
});

test("templates require every provided value and resolve repeated Unicode variables literally", () => {
  const source = "<|speaker:cast-a|>Hello {{name}}. {{挨拶}} {{name}}";
  const parsed = parseSpeechTemplate(source);
  assert.deepEqual(parsed.variables.map(variable => variable.name), ["name", "挨拶", "name"]);
  assert.deepEqual(parsed.diagnostics, []);
  const missing = resolveSpeechTemplate(source, { name: "Zoë 👩🏽‍🚀" });
  assert.equal(missing.source, "");
  assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === "template-missing-value"));
  assert.deepEqual(resolveSpeechTemplate(source, { name: "Zoë 👩🏽‍🚀", 挨拶: "你好" }), {
    source: "<|speaker:cast-a|>Hello Zoë 👩🏽‍🚀. 你好 Zoë 👩🏽‍🚀",
    diagnostics: [],
  });
  assert.equal(resolveSpeechTemplate("A{{optional}}B", { optional: "" }).source, "AB");
  assert.equal(resolveSpeechTemplate("{{value}}", { value: "$& {{other}}" }).source, "$& {{other}}");
  assert.ok(validateSpeechTemplate("{{toString}}", {}).diagnostics.some(diagnostic => diagnostic.code === "template-missing-value"));
});

test("template variables reject injected Fish controls, metadata, and control contexts", () => {
  for (const value of [
    "<|speaker:intruder|>Hello",
    "[angry]Hello",
    "<whisper>Hello</whisper>",
    "<|phoneme_start|>HH AH0<|phoneme_end|>",
    "<!-- hidden -->Hello",
    "# Hidden chapter",
    "Hello\n## Hidden scene",
  ]) {
    const result = resolveSpeechTemplate("Hello {{value}}", { value });
    assert.equal(result.source, "");
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "template-control-value"), value);
  }
  for (const source of ["[{{value}}]Hello", "<|speaker:{{value}}|>Hello", "<!--{{value}}-->Hello", "# {{value}}"]) {
    assert.ok(resolveSpeechTemplate(source, { value: "name" }).diagnostics.length > 0, source);
  }
  assert.ok(resolveSpeechTemplate("#{{value}}Hidden", { value: " " }).diagnostics.length > 0);
});

test("template parsing reports malformed and unmatched delimiters", () => {
  for (const source of ["{{unfinished", "stray }}", "{{}}", "{{bad name}}", "{{outer {{inner}}"]) {
    assert.ok(parseSpeechTemplate(source).diagnostics.length > 0, source);
  }
});

test("text and Markdown imports preserve exact source until metadata removal is explicit", () => {
  const source = "\uFEFF---\r\ntitle: 原文\r\n---\r\n# Heading\r\n**Prose**\r\n<!-- editorial -->\r\n你好 👩🏽‍🚀\r\n";
  for (const format of ["text", "markdown"] as const) {
    assert.deepEqual(importSpeechDocument(source, { format }), { originalSource: source, source, diagnostics: [] });
  }
  const stripped = importSpeechDocument(source, { format: "markdown", stripStructuralMetadata: true });
  assert.equal(stripped.originalSource, source);
  assert.equal(stripped.source, "# Heading\r\n**Prose**\r\n\r\n你好 👩🏽‍🚀\r\n");
  assert.deepEqual(stripped.diagnostics, []);
  assert.ok(importSpeechDocument("---\nno closing delimiter", { format: "markdown", stripStructuralMetadata: true }).diagnostics.length > 0);
  assert.ok(importSpeechDocument("Hello <!-- no close", { format: "markdown", stripStructuralMetadata: true }).diagnostics.length > 0);
});

test("language variant copies and edits preserve the original Unicode script and project fields", () => {
  const original = project();
  const snapshot = JSON.stringify(original);
  const copied = copyProjectVariant(original, null, { id: "de", language: "de-de" });
  assert.equal(copied.source, original.source);
  assert.equal(copied.variants[0].source, original.source);
  assert.equal(copied.variants[0].language, "de-DE");
  const translated = updateProjectVariant(copied, { id: "de", language: "de-DE", source: "Übersetzung 👩🏽‍🚀\r\n第二行" });
  const duplicated = copyProjectVariant(translated, "de", { id: "ja", language: "ja-JP" });
  assert.equal(duplicated.source, original.source);
  assert.equal(duplicated.variants[0].source, "Übersetzung 👩🏽‍🚀\r\n第二行");
  assert.equal(duplicated.variants[1].source, duplicated.variants[0].source);
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual({ ...duplicated, variants: [] }, original);
});

test("variant operations reject unknown IDs and invalid languages without creating substitutes", () => {
  const original = project();
  assert.throws(() => copyProjectVariant(original, "missing", { id: "de", language: "de-DE" }), /existing variant/u);
  assert.throws(() => createProjectVariant(original, { id: "de", language: "not_a_language", source: "" }), /valid language/u);
  const copied = copyProjectVariant(original, null, { id: "de", language: "de-DE" });
  assert.throws(() => copyProjectVariant(copied, null, { id: "de", language: "en-US" }), /unique/u);
  assert.throws(() => updateProjectVariant(original, { id: "de", language: "de-DE", source: "" }), /existing variant/u);
});

test("reading sentences retain source offsets and omit editorial and performance controls", () => {
  const source = "# Chapter\n<|speaker:cast-a|>Hello world. 你好！\n<!-- private -->[soft]Next sentence.";
  const sentences = readingSentences(source);
  assert.ok(sentences.length >= 3);
  assert.ok(sentences.every(sentence => source.slice(sentence.from, sentence.to) === sentence.text));
  assert.ok(sentences.every(sentence => !/[<>#[\]]/u.test(sentence.text)));
  assert.ok(sentences.some(sentence => sentence.text === "你好！"));
  assert.equal(sentences[0].source, "<|speaker:cast-a|>Hello world.");
  assert.equal(sentences.at(-1)?.source, "<|speaker:cast-a|>[soft]Next sentence.");
  assert.deepEqual(readingSentences("<|speaker:cast-b|><whisper>Hello. Next.</whisper>").map(sentence => sentence.source), [
    "<|speaker:cast-b|><whisper>Hello.</whisper>",
    "<|speaker:cast-b|><whisper>Next.</whisper>",
  ]);
});
