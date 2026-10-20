import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface MarkdownNode {
  type: string;
  value?: string;
  alt?: string;
  lang?: string | null;
  children?: MarkdownNode[];
}
export interface AnswerSpeechPolicy { readCode?: boolean; announceOmissions?: boolean }
export function answerSpeechRevision(markdown:string):string{
  let revision=2166136261;
  for(let index=0;index<markdown.length;index++)revision=Math.imul(revision^markdown.charCodeAt(index),16777619);
  return (revision>>>0).toString(36);
}
export interface FinalAnswerEvent {
  kind: "answer";
  channel: "final";
  audience: "user";
  sessionId: string;
  answerId: string;
  revision: string;
  markdown: string;
  complete: boolean;
}
export interface SpeakableAnswerSegment {
  id: string;
  answerId: string;
  revision: string;
  sessionId: string;
  text: string;
  sourceFrom: number;
  sourceTo: number;
}

export function literalSpeechText(value: string): string {
  return value.replace(/[<>[\]]/gu, character => ({ "<": " less than ", ">": " greater than ", "[": " open bracket ", "]": " close bracket " })[character]!)
    .replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
}

export function markdownToSpeech(markdown: string, policy: AnswerSpeechPolicy = {}): string {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MarkdownNode;
  const omission = (description: string): string => policy.announceOmissions === false ? "" : `${description} omitted. `;
  const text = (node: MarkdownNode): string => {
    const children = (): string => node.children?.map(text).join("") ?? "";
    switch (node.type) {
      case "text": return (node.value ?? "").replace(/\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]*?\S\$(?!\d)/gu, () => omission("Math"));
      case "code": return node.lang === "mermaid" ? omission("Diagram") : policy.readCode ? `${node.value ?? ""}. ` : omission("Code sample");
      case "inlineCode": return policy.readCode ? node.value ?? "" : omission("Code");
      case "html": case "definition": case "footnoteDefinition": case "footnoteReference": return "";
      case "image": case "imageReference": return node.alt ? `${node.alt}. ` : omission("Image");
      case "break": case "thematicBreak": return ". ";
      case "heading": case "paragraph": case "blockquote": case "listItem": return `${children()}\n`;
      case "table": {
        const rows = node.children ?? [];
        const headers = rows[0]?.children?.map(text) ?? [];
        return rows.slice(1).map(row => row.children?.map((cell, index) => `${headers[index] ? `${headers[index]}: ` : ""}${text(cell)}`).join("; ")).join(". ") + ". ";
      }
      default: return children();
    }
  };
  return literalSpeechText(text(root).replace(/\n+/gu, ". ").replace(/([.!?])\s*\./gu, "$1"));
}

export function isFinalAnswerEvent(value: unknown): value is FinalAnswerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<FinalAnswerEvent>;
  return event.kind === "answer" && event.channel === "final" && event.audience === "user" && typeof event.sessionId === "string" && typeof event.answerId === "string" && typeof event.revision === "string" && typeof event.markdown === "string" && typeof event.complete === "boolean";
}

function safeSentenceEnd(source: string, complete: boolean): number {
  let fence: { character: string; count: number } | undefined;
  let inlineTicks = 0;
  let brackets = 0;
  let parentheses = 0;
  let angle = false;
  let entity = false;
  let lastSafe = 0;
  let mathTicks=0;
  let mathStart=0;
  let lineStart = true;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (lineStart) {
      const marker = /^( {0,3})(`{3,}|~{3,})/u.exec(source.slice(index));
      if (marker) {
        const run = marker[2]!;
        if (!fence) fence = { character: run[0]!, count: run.length };
        else if (run[0] === fence.character && run.length >= fence.count) fence = undefined;
        index += marker[0].length - 1;
        lineStart = false;
        continue;
      }
    }
    lineStart = character === "\n";
    if (fence) continue;
    if (character === "\\") { index++; continue; }
    if (character === "`") {
      const run = /^`+/u.exec(source.slice(index))![0].length;
      inlineTicks = inlineTicks === run ? 0 : inlineTicks === 0 ? run : inlineTicks;
      index += run - 1;
      continue;
    }
    if (inlineTicks) continue;
    if(character==="$"){
      const run=source[index+1]==="$"?2:1;
      if(!mathTicks&&(run===2||source[index+run]===undefined||!/\s/u.test(source[index+run]!))){mathTicks=run;mathStart=index;}
      else if(mathTicks===run&&(run===2||!/\s/u.test(source[index-1]??"")&&!/\d/u.test(source[index+run]??"")))mathTicks=0;
      index+=run-1;continue;
    }
    if(mathTicks)continue;
    if (character === "<") angle = true;
    if (character === ">") angle = false;
    if (character === "&") entity = true;
    if (character === ";" || /\s/u.test(character)) entity = false;
    if (character === "[") brackets++;
    if (character === "]") brackets = Math.max(0, brackets - 1);
    if (character === "(") parentheses++;
    if (character === ")") parentheses = Math.max(0, parentheses - 1);
    if (!angle && !entity && brackets === 0 && parentheses === 0 && ((/[.!?。！？]/u.test(character) && (index + 1 < source.length && /\s/u.test(source[index + 1]!))) || character === "\n")) {
      const prefix = source.slice(Math.max(0, index - 12), index + 1);
      if (!/(?:\b(?:Dr|Mr|Mrs|Ms|Prof|e\.g|i\.e|vs|etc)|\b[A-Z])\.$/u.test(prefix)) lastSafe = index + 1;
    }
  }
  if(complete&&fence)return source.length;
  if (complete && !fence && inlineTicks === 0 && !angle && !entity && brackets === 0 && parentheses === 0){
    if(!mathTicks||mathTicks===1&&/^\$\d/u.test(source.slice(mathStart)))return source.length;
    return Math.max(lastSafe,mathStart);
  }
  const blanks=[...source.matchAll(/\r?\n[ \t]*\r?\n/gu)];
  const lastBlank=blanks.at(-1);
  const blockStart=lastBlank?lastBlank.index+lastBlank[0].length:0;
  if(source.slice(blockStart).replace(/<[^>\n]*(?:>|$)/gu,"").includes("|"))lastSafe=Math.min(lastSafe,blockStart);
  return lastSafe;
}

export class IncrementalAnswerSpeech {
  private current: FinalAnswerEvent | undefined;
  private committedOffset = 0;
  private segmentCount = 0;
  private obsolete = false;
  private readonly policy: AnswerSpeechPolicy;
  constructor(policy: AnswerSpeechPolicy = {}) { this.policy = policy; }

  update(value: unknown): { segments: SpeakableAnswerSegment[]; replaced: boolean } {
    if (!isFinalAnswerEvent(value)) return { segments: [], replaced: false };
    const previous = this.current;
    const sameAnswer = previous?.sessionId === value.sessionId && previous.answerId === value.answerId;
    const revised = sameAnswer && (previous.revision !== value.revision || !value.markdown.startsWith(previous.markdown));
    if (revised) {
      this.current = value;
      this.obsolete = true;
      return { segments: [], replaced: true };
    }
    if (!sameAnswer) { this.committedOffset = 0; this.segmentCount = 0; this.obsolete = false; }
    this.current = value;
    if (this.obsolete) return { segments: [], replaced: false };
    const pending = value.markdown.slice(this.committedOffset);
    const safeEnd = safeSentenceEnd(pending, value.complete);
    if (!safeEnd) return { segments: [], replaced: false };
    const from = this.committedOffset;
    this.committedOffset += safeEnd;
    const speakable = markdownToSpeech(pending.slice(0, safeEnd), this.policy);
    return { replaced: false, segments: speakable ? [{ id: `${value.sessionId}:${value.answerId}:${value.revision}:${this.segmentCount++}`, answerId: value.answerId, revision: value.revision, sessionId: value.sessionId, text: speakable, sourceFrom: from, sourceTo: this.committedOffset }] : [] };
  }

  reset(): void { this.current = undefined; this.committedOffset = 0; this.segmentCount = 0; this.obsolete = false; }
}

export class AnswerSpeechLedger {
  private readonly revisions = new Map<string, string>();
  private readonly capacity: number;
  constructor(capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("Answer speech history needs a positive capacity.");
    this.capacity = capacity;
  }
  prime(events: ReadonlyArray<FinalAnswerEvent>): void { for (const event of events) this.record(event); }
  accept(event: FinalAnswerEvent): "new" | "duplicate" | "revised" {
    const key = `${event.sessionId}:${event.answerId}`;
    const previous = this.revisions.get(key);
    if (previous !== undefined) return previous === event.revision ? "duplicate" : "revised";
    this.record(event);
    return "new";
  }
  private record(event: FinalAnswerEvent): void {
    this.revisions.set(`${event.sessionId}:${event.answerId}`, event.revision);
    if (this.revisions.size > this.capacity) this.revisions.delete(this.revisions.keys().next().value!);
  }
}
