import { parseSpeechScript, type ParseSpeechOptions, type SourceRange, type SpeechDiagnostic, type SpeechNode, type SpeechScript } from "./script.ts";
import type { SpeechBackend, SpeechChapter, SpeechRenderSegment } from "./runtime.ts";
import {resolveSpeechSceneBinding,type SpeechSceneBindingOverride} from "./scene-casting.ts";

export interface SpeechCastBinding {
  id: string;
  name: string;
  voiceId?: string;
  referenceHashes?: string[];
  direction?: string;
  sceneOverrides?:readonly SpeechSceneBindingOverride[];
}
export interface SpeechCompileOptions extends ParseSpeechOptions {
  backend?: SpeechBackend;
  cast: ReadonlyArray<SpeechCastBinding>;
  defaultSpeakerId?: string;
  maxUtf8Bytes?: number;
  maxSpeakers?: number;
  segmentTargetUtf8Bytes?: number;
  selection?: SourceRange;
}
export interface SpeechSourceMap extends SourceRange { outputFrom: number; outputTo: number; nodeId: string }
export interface CompiledSpeechSegment {
  id: string;
  text: string;
  speakers: SpeechCastBinding[];
  sourceMap: SpeechSourceMap[];
  utf8Bytes: number;
  characters: number;
  estimatedDurationSeconds: number;
  spokenText: string;
  chapter: SpeechChapter | null;
}
export interface CompiledSpeech { script: SpeechScript; segments: CompiledSpeechSegment[]; diagnostics: SpeechDiagnostic[] }
export function speechRenderSegment(segment: CompiledSpeechSegment): SpeechRenderSegment {
  const stored = segment.speakers.filter(speaker=>speaker.voiceId);
  if (stored.length && stored.length!==segment.speakers.length) throw new Error("Use stored voices for every dialogue speaker, or reference sets for every speaker. Save reference sets as voices to combine them with library voices.");
  if (stored.length && stored.some(speaker=>speaker.referenceHashes?.length)) throw new Error("Choose either a voice ID or a reference set for each cast member.");
  const groups=segment.speakers.map(speaker=>speaker.referenceHashes??[]);
  return {id:segment.id,text:segment.text,spokenText:segment.spokenText,chapter:segment.chapter,voiceIds:stored.map(speaker=>speaker.voiceId!),referenceAssetIds:groups.flat(),...(groups.length>1&&!stored.length?{referenceGroups:groups}:{})};
}
const encoder = new TextEncoder();
const sentenceSegmenter = new Intl.Segmenter("und", { granularity: "sentence" });

function segmentIdentity(text: string, speakers: ReadonlyArray<SpeechCastBinding>): string {
  const value = JSON.stringify([text, speakers.map(speaker=>[speaker.id,speaker.voiceId??null,speaker.referenceHashes??[],speaker.direction??""])]);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ value.charCodeAt(index);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function splitText(node: SpeechNode, maxBytes?: number): SpeechNode[] {
  const paragraphs = node.raw.match(/[^\n]+(?:\n+|$)|\n+/gu) ?? [];
  const parts = paragraphs.flatMap(paragraph => maxBytes && encoder.encode(paragraph).length > maxBytes
    ? [...sentenceSegmenter.segment(paragraph)].map(item => item.segment)
    : [paragraph]);
  let cursor = node.from;
  return parts.map((raw, index) => {
    const next = { ...node, id: `${node.id}-${index}`, raw, value: raw, from: cursor, to: cursor + raw.length };
    cursor += raw.length;
    return next;
  });
}

export function compileSpeechScript(source: string | SpeechScript, options: SpeechCompileOptions): CompiledSpeech {
  const script = typeof source === "string" ? parseSpeechScript(source, options) : source;
  if (options.selection) {
    const { selection, ...rest } = options;
    if (selection.from < 0 || selection.to < selection.from || selection.to > script.source.length) throw new Error("Selection is outside the script.");
    const diagnostics = [...script.diagnostics];
    const scopeAt = (position: number): SpeechNode[] => {
      const stack: SpeechNode[] = [];
      for (const node of script.nodes) {
        if (node.to > position) break;
        if (node.kind === "openTag") stack.push(node);
        if (node.kind === "closeTag") stack.pop();
      }
      return stack;
    };
    for (const node of script.nodes) if (node.kind !== "text" && node.to > selection.from && node.from < selection.to && (node.from < selection.from || node.to > selection.to)) diagnostics.push({ ...node, severity: "error", code: "partial-control", message: "Select the complete performance control." });
    const dividesSurrogate = (position: number): boolean => /[\uD800-\uDBFF]/u.test(script.source[position - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(script.source[position] ?? "");
    if (dividesSurrogate(selection.from) || dividesSurrogate(selection.to)) diagnostics.push({ ...selection, severity: "error", code: "partial-unicode", message: "Select the complete Unicode character." });
    if (diagnostics.some(item => item.severity === "error")) return { script, segments: [], diagnostics };
    const opening = scopeAt(selection.from).map(node => node.raw).join("");
    const closing = scopeAt(selection.to).reverse().map(node => `</${node.value}>`).join("");
    const speaker = script.nodes.filter(node => node.kind === "speaker" && node.to <= selection.from).at(-1)?.value ?? options.defaultSpeakerId;
    const precedingChapter = script.nodes.filter(node => node.kind === "chapter" && node.to <= selection.from).at(-1);
    const precedingScene=script.nodes.filter(node=>node.kind==="scene"&&node.to<=selection.from&&(!precedingChapter||node.from>precedingChapter.from)).at(-1);
    const selected=parseSpeechScript(opening+script.source.slice(selection.from,selection.to)+closing,rest);
    const originalNodes=new Map(script.nodes.map(node=>[`${node.kind}:${node.from}:${node.to}`,node]));
    const mapOffset=(offset:number)=>Math.max(selection.from,Math.min(selection.to,offset-opening.length+selection.from));
    selected.nodes=selected.nodes.map(node=>{
      const from=mapOffset(node.from),to=mapOffset(node.to);
      const original=originalNodes.get(`${node.kind}:${from}:${to}`);
      return {...node,from,to,...(original?{id:original.id}:{})};
    });
    selected.source=script.source;
    selected.nodes.unshift(...[precedingChapter,precedingScene].flatMap(node=>node?[{...node,raw:"",from:selection.from,to:selection.from}]:[]));
    const compiled=compileSpeechScript(selected,{...rest,...(speaker?{defaultSpeakerId:speaker}:{})});
    return {...compiled,script};
  }
  const diagnostics = [...script.diagnostics];
  const segments: CompiledSpeechSegment[] = [];
  const occurrences = new Map<string, number>();
  const cast = new Map(options.cast.map(binding => [binding.id, binding]));
  const addError = (node: SourceRange, code: string, message: string): void => { diagnostics.push({ ...node, severity: "error", code, message }); };
  if (options.backend === "openai" || options.backend === "google") {
    for (const node of script.nodes) if (["direction", "openTag", "closeTag", "phoneme"].includes(node.kind)) {
      addError(node, "unsupported-provider-control", "Use Drama 3 for performance markup, or move the direction to the speech profile.");
    }
    if (options.cast.some(binding => binding.direction?.trim() || binding.sceneOverrides?.some(override => override.direction?.trim()))) {
      addError({ from: 0, to: 0 }, "unsupported-cast-direction", "Use the speech profile direction for this provider, or choose Drama 3 for cast directions.");
    }
  }
  if (cast.size !== options.cast.length) addError({ from: 0, to: 0 }, "duplicate-cast-id", "Give each cast member a unique stable ID.");
  for(const binding of options.cast){const scopes=new Set<string>();for(const override of binding.sceneOverrides??[]){if(scopes.has(override.sceneId))addError({from:0,to:0},"duplicate-cast-scope","Keep one cast override per chapter or scene.");scopes.add(override.sceneId);}}
  const voiceIds = options.cast.flatMap(binding => binding.voiceId ? [binding.voiceId] : []);
  if (new Set(voiceIds).size !== voiceIds.length) diagnostics.push({ from: 0, to: 0, severity: "warning", code: "repeated-voice", message: "Multiple cast members use the same voice." });
  if (options.maxUtf8Bytes !== undefined && (!Number.isSafeInteger(options.maxUtf8Bytes) || options.maxUtf8Bytes <= 0)) throw new Error("Use a positive verified request byte limit.");
  if (options.segmentTargetUtf8Bytes !== undefined && (!Number.isSafeInteger(options.segmentTargetUtf8Bytes) || options.segmentTargetUtf8Bytes <= 0)) throw new Error("Use a positive application segment size.");
  const segmentTarget = Math.min(options.segmentTargetUtf8Bytes ?? (options.backend === "openai" ? 4096 : 16_000), options.maxUtf8Bytes ?? Infinity);
  let activeSpeaker = options.defaultSpeakerId ?? options.cast[0]?.id;
  let text = "";
  let speakers: SpeechCastBinding[] = [];
  let sourceMap: SpeechSourceMap[] = [];
  let currentSpeaker: string | undefined;
  let audible = false;
  let chapter: SpeechChapter | null = null;
  let sceneId:string|null=null;
  const flush = (): void => {
    if (audible) {
      const plain = parseSpeechScript(text).nodes.filter(node => node.kind === "text" || node.kind === "phoneme").map(node => node.value).join("");
      const count = Array.from(plain).length;
      const identity = segmentIdentity(text, speakers);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      segments.push({ id: `segment-${identity}-${occurrence}`, text, speakers, sourceMap, utf8Bytes: encoder.encode(text).length, characters: Array.from(text).length, estimatedDurationSeconds: Math.max(1, count / 14), spokenText: plain.trim(), chapter });
    }
    text = ""; speakers = []; sourceMap = []; currentSpeaker = undefined; audible = false;
  };
  const speakerPrefix = (id: string | undefined): string => {
    if (!id) return "";
    const original = cast.get(id);
    if (!original) return "";
    const binding=resolveSpeechSceneBinding(original,[chapter?.id,sceneId]);
    let index = speakers.findIndex(value => value.id === id);
    if (index < 0) { index = speakers.length; speakers.push(binding); }
    if (currentSpeaker === id) return "";
    currentSpeaker = id;
    const direction = binding.direction?.trim();
    return `<|speaker:${index}|>${direction ? `[${direction}]` : ""}`;
  };
  const nodes = script.nodes.flatMap(node => node.kind === "text" ? splitText(node, segmentTarget) : [node]);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.kind === "speaker") {
      activeSpeaker = node.value;
      if (!cast.has(activeSpeaker)) addError(node, "unmapped-speaker", `Assign a voice to speaker ${activeSpeaker}.`);
      continue;
    }
    if (node.kind === "chapter" || node.kind === "scene") { flush(); if (node.kind === "chapter"){chapter = { id: node.id, title: node.value };sceneId=null;}else sceneId=node.id; continue; }
    if (node.kind === "comment") continue;
    let unit = node.raw;
    const sourceStart = node.from;
    let endIndex = index;
    if (node.kind === "openTag") {
      let depth = 1;
      while (depth > 0 && endIndex + 1 < nodes.length) {
        const next = nodes[++endIndex]!;
        if (next.kind === "openTag") depth++;
        if (next.kind === "closeTag") depth--;
        if (next.kind !== "comment") unit += next.raw;
      }
    }
    if (!unit.trim()) { if (text) text += unit; continue; }
    const originalBinding = activeSpeaker ? cast.get(activeSpeaker) : undefined;
    const binding=originalBinding?resolveSpeechSceneBinding(originalBinding,[chapter?.id,sceneId]):undefined;
    if (!(options.backend === "drama3" && options.cast.length === 0) && (!binding || (!binding.voiceId && !binding.referenceHashes?.length))) addError(node, "missing-voice", "Assign a voice or reference set before rendering.");
    if (options.backend === "drama3" && binding?.voiceId) addError(node, "local-reference", "Use reference recordings for local voice cloning. Library voices require Fish Cloud.");
    if (binding?.direction && /[<>[\]\r\n]/u.test(binding.direction)) addError(node, "invalid-cast-direction", "Use plain direction text without control delimiters.");
    const beforeSpeakers = [...speakers];
    const beforeSpeaker = currentSpeaker;
    let prefix = speakerPrefix(activeSpeaker);
    const max = options.maxUtf8Bytes;
    const capacityExceeded = options.maxSpeakers !== undefined && speakers.length > options.maxSpeakers;
    if (audible && (capacityExceeded || encoder.encode(text + prefix + unit).length > segmentTarget)) {
      speakers = beforeSpeakers; currentSpeaker = beforeSpeaker;
      flush();
      prefix = speakerPrefix(activeSpeaker);
    }
    const outputFrom = text.length + prefix.length;
    text += prefix + unit;
    sourceMap.push({ from: sourceStart, to: nodes[endIndex]!.to, outputFrom, outputTo: text.length, nodeId: node.id });
    if (max !== undefined && encoder.encode(text).length > max) addError(node, "oversized-scope", "Shorten this paragraph or delivery scope to fit the verified request limit.");
    if (options.maxSpeakers !== undefined && speakers.length > options.maxSpeakers) addError(node, "speaker-limit", "Reduce speakers to the verified backend capacity.");
    audible ||= node.kind === "text" || node.kind === "phoneme" || node.kind === "openTag";
    index = endIndex;
  }
  flush();
  return { script, segments: diagnostics.some(value => value.severity === "error") ? [] : segments, diagnostics };
}

export async function speechContentHash(value: unknown): Promise<string> {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    if (typeof input === "number" && !Number.isFinite(input)) throw new Error("Speech snapshots require finite numbers.");
    return input;
  };
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
