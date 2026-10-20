export const DELIVERY_TAGS = ["whisper", "emphasis", "soft", "fast", "slow", "stress", "forceful"] as const;
export type DeliveryTag = typeof DELIVERY_TAGS[number];
export type PhonemeAlphabet = "arpabet" | "pinyin" | "romaji";
export const MAX_SPEECH_SOURCE_BYTES = 4 * 1024 * 1024;
export interface SourceRange { from: number; to: number }
export interface SpeechDiagnostic extends SourceRange {
  severity: "error" | "warning";
  code: string;
  message: string;
}
export type SpeechNodeKind = "text" | "speaker" | "direction" | "openTag" | "closeTag" | "phoneme" | "comment" | "chapter" | "scene";
export interface SpeechNode extends SourceRange {
  id: string;
  kind: SpeechNodeKind;
  raw: string;
  value: string;
}
export interface SpeechScript {
  source: string;
  nodes: SpeechNode[];
  diagnostics: SpeechDiagnostic[];
  characters: number;
  utf8Bytes: number;
}
export interface ParseSpeechOptions { phonemeAlphabet?: PhonemeAlphabet }

const encoder = new TextEncoder();
const arpabet = /^(?:AA|AE|AH|AO|AW|AY|B|CH|D|DH|EH|ER|EY|F|G|HH|IH|IY|JH|K|L|M|N|NG|OW|OY|P|R|S|SH|T|TH|UH|UW|V|W|Y|Z|ZH)[012]?$/;
const vowels = /^(?:AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)/;

export function validatePhonemes(value: string, alphabet: PhonemeAlphabet): boolean {
  if (!value.trim()) return false;
  const tokens = value.trim().split(/\s+/u);
  if (alphabet === "arpabet") return tokens.every(token => arpabet.test(token) && (!/[012]$/.test(token) || vowels.test(token)));
  if (alphabet === "pinyin") return tokens.every(token => /^(?:[a-züv]+[1-5]?|[\p{Script=Latin}\p{M}]+)$/u.test(token));
  return tokens.every(token => /^[a-zāīūēōâîûêô'-]+(?:[01][a-zāīūēōâîûêô'-]+)*[01]?$/iu.test(token));
}

function nodeIdentity(kind: string, raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return `${kind}-${(hash >>> 0).toString(36)}`;
}

export function parseSpeechScript(source: string, options: ParseSpeechOptions = {}): SpeechScript {
  const nodes: SpeechNode[] = [];
  const diagnostics: SpeechDiagnostic[] = [];
  const stack: SpeechNode[] = [];
  const occurrences = new Map<string, number>();
  const add = (kind: SpeechNodeKind, from: number, to: number, value: string): SpeechNode => {
    const raw = source.slice(from, to);
    const identity = nodeIdentity(kind, raw);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const node = { id: `${identity}-${occurrence}`, kind, from, to, raw, value };
    nodes.push(node);
    return node;
  };
  const error = (from: number, to: number, code: string, message: string): void => {
    diagnostics.push({ from, to, severity: "error", code, message });
  };
  let cursor = 0;
  while (cursor < source.length) {
    const tail = source.slice(cursor);
    if (tail.startsWith("<!--")) {
      const closing = source.indexOf("-->", cursor + 4);
      if (closing < 0) {
        add("comment", cursor, source.length, tail.slice(4));
        error(cursor, source.length, "unclosed-comment", "Close the editorial comment with -->.");
        break;
      }
      add("comment", cursor, closing + 3, source.slice(cursor + 4, closing));
      cursor = closing + 3;
      continue;
    }
    if ((cursor === 0 || source[cursor - 1] === "\n") && /^#{1,2} /u.test(tail)) {
      const end = source.indexOf("\n", cursor);
      const to = end < 0 ? source.length : end + 1;
      const heading = /^(#{1,2}) ([^\r\n]*)/u.exec(tail)!;
      if (stack.length) error(cursor, to, "scope-across-structure", "Close delivery tags before a chapter or scene.");
      add(heading[1]!.length === 1 ? "chapter" : "scene", cursor, to, heading[2]!);
      cursor = to;
      continue;
    }
    const speaker = /^<\|speaker:([A-Za-z0-9_-]+)\|>/u.exec(tail);
    if (speaker) {
      if (stack.length) error(cursor, cursor + speaker[0].length, "scope-across-speaker", "Close delivery tags before changing speakers.");
      add("speaker", cursor, cursor + speaker[0].length, speaker[1]!);
      cursor += speaker[0].length;
      continue;
    }
    if (tail.startsWith("<|phoneme_start|>")) {
      const start = cursor + "<|phoneme_start|>".length;
      const closing = source.indexOf("<|phoneme_end|>", start);
      const to = closing < 0 ? source.length : closing + "<|phoneme_end|>".length;
      const value = source.slice(start, closing < 0 ? source.length : closing);
      add("phoneme", cursor, to, value);
      if (closing < 0) error(cursor, to, "unclosed-phoneme", "Close the phoneme span with <|phoneme_end|>.");
      if (/[<>[\]]/u.test(value) || (options.phonemeAlphabet && !validatePhonemes(value, options.phonemeAlphabet))) {
        error(start, closing < 0 ? source.length : closing, "invalid-phoneme", `Use valid ${options.phonemeAlphabet ?? "phoneme"} notation without nested controls.`);
      }
      cursor = to;
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][\w-]*)>/u.exec(tail);
    if (tag) {
      const closing = tag[1] === "/";
      const node = add(closing ? "closeTag" : "openTag", cursor, cursor + tag[0].length, tag[2]!);
      if (!(DELIVERY_TAGS as readonly string[]).includes(tag[2]!)) {
        error(node.from, node.to, "unsupported-tag", "Use a documented delivery tag or remove this markup.");
      } else if (!closing) {
        stack.push(node);
      } else if (stack.at(-1)?.value === tag[2]) {
        stack.pop();
      } else {
        error(node.from, node.to, "crossed-tag", `Close ${stack.at(-1)?.value ?? "an open delivery tag"} before ${tag[2]}.`);
      }
      cursor = node.to;
      continue;
    }
    if (source[cursor] === "[") {
      const closing = source.indexOf("]", cursor + 1);
      const lineEnd = source.indexOf("\n", cursor + 1);
      const to = closing < 0 || (lineEnd >= 0 && lineEnd < closing) ? (lineEnd < 0 ? source.length : lineEnd) : closing + 1;
      const value = source.slice(cursor + 1, closing < 0 ? to : Math.min(closing, to));
      add("direction", cursor, to, value);
      if (closing < 0 || to <= closing) error(cursor, to, "unclosed-direction", "Close the performance direction with ].");
      if (!value.trim() || /[[<>]/u.test(value)) error(cursor, to, "invalid-direction", "Use a nonempty direction without nested control markup.");
      cursor = to;
      continue;
    }
    if (/[<>\]]/u.test(source[cursor]!)) {
      const malformed = /^(?:<[^\n>]*>?|.)/u.exec(tail)![0];
      add("text", cursor, cursor + malformed.length, malformed);
      error(cursor, cursor + malformed.length, "unsupported-literal", "Spell out literal bracket symbols or remove unsupported control markup.");
      cursor += malformed.length;
      continue;
    }
    let end = cursor + 1;
    while (end < source.length && !/[<>[\]]/u.test(source[end]!) && !(source[end - 1] === "\n" && /^#{1,2} /u.test(source.slice(end)))) end++;
    add("text", cursor, end, source.slice(cursor, end));
    cursor = end;
  }
  for (const tag of stack) error(tag.from, tag.to, "unclosed-tag", `Close <${tag.value}> with </${tag.value}>.`);
  return { source, nodes, diagnostics, characters: Array.from(source).length, utf8Bytes: encoder.encode(source).length };
}

export function serializeSpeechScript(script: SpeechScript): string {
  return script.nodes.map(node => node.raw).join("");
}

export interface SpeechCompletion { label: string; insertText: string; kind: "speaker" | "tag" | "phoneme" | "direction" }
export function speechCompletions(source: string, position: number, speakers: ReadonlyArray<{ id: string; name: string }> = []): SpeechCompletion[] {
  const before = source.slice(0, position);
  if (/<\|speaker:[^|>]*$/u.test(before)) return speakers.map(speaker => ({ label: speaker.name, insertText: `${speaker.id}|>`, kind: "speaker" }));
  if (/<\/?[\w-]*$/u.test(before)) return DELIVERY_TAGS.map(tag => ({ label: tag, insertText: before.endsWith("</") ? `${tag}>` : `${tag}></${tag}>`, kind: "tag" }));
  if (before.endsWith("<|")) return [{ label: "phoneme", insertText: "phoneme_start|><|phoneme_end|>", kind: "phoneme" }];
  return [];
}

export function wrapSpeechSelection(source: string, range: SourceRange, tag: DeliveryTag): { source: string; selection: SourceRange } {
  const opening = `<${tag}>`;
  return { source: source.slice(0, range.from) + opening + source.slice(range.from, range.to) + `</${tag}>` + source.slice(range.to), selection: { from: range.from + opening.length, to: range.to + opening.length } };
}
