import { MAX_SPEECH_SOURCE_BYTES, parseSpeechScript, validatePhonemes, type SourceRange } from "./script.ts";
import type { SpeechCastMember, SpeechDictionary, SpeechOperations, SpeechProject } from "./runtime.ts";

export type SpeechAssistanceInput = SpeechOperations["assist"]["input"];
export interface SpeechAssistanceProposal {
  source: string;
  cast: Array<{ id: string; direction: string; voiceId?: string }>;
  rules: Array<Omit<SpeechDictionary["rules"][number], "id">>;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("The task model returned an unexpected proposal field.");
  return value as Record<string, unknown>;
}

export function validateSpeechAssistance(value: unknown, input: SpeechAssistanceInput): SpeechAssistanceProposal {
  const proposal = object(value, ["source", "cast", "rules"]);
  if (typeof proposal.source !== "string" || new TextEncoder().encode(proposal.source).byteLength > 262_144 || !Array.isArray(proposal.cast) || proposal.cast.length !== input.cast.length || !Array.isArray(proposal.rules) || proposal.rules.length > 1000) throw new Error("The task model returned an incomplete or oversized proposal.");
  const parsed = parseSpeechScript(proposal.source);
  if (parsed.diagnostics.some(item => item.severity === "error")) throw new Error("The proposal contains invalid speech controls. Refine the request and retry.");
  const original = parseSpeechScript(input.source);
  const signature = (kind: "speaker" | "chapter" | "scene" | "comment"): string => JSON.stringify(original.nodes.filter(node => node.kind === kind).map(node => node.value));
  for (const kind of ["speaker", "chapter", "scene", "comment"] as const) {
    if (signature(kind) !== JSON.stringify(parsed.nodes.filter(node => node.kind === kind).map(node => node.value))) throw new Error("The proposal changed the cast, chapter structure or editorial comments.");
  }
  if (input.action !== "localization") {
    const words = (source: ReturnType<typeof parseSpeechScript>): string => source.nodes.filter(node => node.kind === "text" || node.kind === "phoneme").map(node => node.raw).join("");
    if (words(original) !== words(parsed)) throw new Error("The proposal changed dialogue words. Request direction changes without rewriting the script.");
  }
  if (input.action !== "direction" && input.action !== "localization" && proposal.source !== input.source) throw new Error("This assistance action must leave the script unchanged.");
  const ids = new Set<string>();
  const cast = proposal.cast.map((value): SpeechAssistanceProposal["cast"][number] => {
    const member = object(value, ["id", "direction", "voiceId"]);
    const original = input.cast.find(item => item.id === member.id);
    if (!original || typeof member.id !== "string" || ids.has(member.id) || typeof member.direction !== "string" || member.direction.length > 32_768 || /[<>[\]\r\n]/u.test(member.direction) || (member.voiceId !== undefined && typeof member.voiceId !== "string")) throw new Error("The proposal contains invalid cast bindings.");
    ids.add(member.id);
    if (input.action !== "casting" && member.voiceId !== original.voiceId) throw new Error("The proposal changed a voice outside a casting request.");
    if (!["direction", "casting"].includes(input.action) && member.direction !== original.direction) throw new Error("The proposal changed cast direction outside a direction request.");
    if (member.voiceId && member.voiceId !== original.voiceId && !input.voices.some(voice => voice.id === member.voiceId)) throw new Error("The proposal invented a voice outside the supplied library.");
    return { id: member.id, direction: member.direction, ...(typeof member.voiceId === "string" ? { voiceId: member.voiceId } : {}) };
  });
  if (input.action !== "pronunciation" && proposal.rules.length) throw new Error("The proposal added pronunciation rules outside a pronunciation request.");
  const rules = proposal.rules.map((value): SpeechAssistanceProposal["rules"][number] => {
    const rule = object(value, ["text", "phonemes", "alphabet", "caseSensitive"]);
    if (typeof rule.text !== "string" || !rule.text.trim() || rule.text.length > 16_384 || typeof rule.phonemes !== "string" || rule.phonemes.length > 16_384 || !["arpabet", "pinyin", "romaji"].includes(String(rule.alphabet)) || typeof rule.caseSensitive !== "boolean") throw new Error("The proposal contains an invalid pronunciation rule.");
    const alphabet = rule.alphabet as "arpabet" | "pinyin" | "romaji";
    if (!validatePhonemes(rule.phonemes, alphabet)) throw new Error("The proposed pronunciation does not match its alphabet.");
    return { text: rule.text, phonemes: rule.phonemes, alphabet, caseSensitive: rule.caseSensitive };
  });
  return { source: proposal.source, cast, rules };
}

export function applySuggestedCast(cast: SpeechCastMember[], proposal: SpeechAssistanceProposal): SpeechCastMember[] {
  return cast.map(member => {
    const suggested = proposal.cast.find(item => item.id === member.id);
    if (!suggested) throw new Error("The cast changed after this proposal was generated.");
    const next = { ...member, direction: suggested.direction };
    if (suggested.voiceId) next.voiceId = suggested.voiceId;
    else delete next.voiceId;
    return next;
  });
}

export function applySpeechAssistance(project:SpeechProject,input:SpeechAssistanceInput,proposal:unknown,range?:SourceRange):SpeechProject{
  const from=range?.from??0,to=range?.to??project.source.length;
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to>project.source.length)
    throw new Error("Choose an assistance target within the current script.");
  for(const offset of [from,to])if(offset>0&&/[\uD800-\uDBFF]/u.test(project.source[offset-1]!)&&/[\uDC00-\uDFFF]/u.test(project.source[offset]??""))
    throw new Error("Choose a target at complete Unicode character boundaries.");
  if(project.source.slice(from,to)!==input.source)throw new Error("The assistance target changed. Generate a new proposal.");
  const value=validateSpeechAssistance(proposal,input);
  const source=project.source.slice(0,from)+value.source+project.source.slice(to);
  if(new TextEncoder().encode(source).byteLength>MAX_SPEECH_SOURCE_BYTES)throw new Error("The proposed script exceeds 4 MiB. Choose a smaller target or shorten the proposal.");
  if(input.action==="localization"){
    const language=Intl.getCanonicalLocales(input.language??"")[0];
    if(!language)throw new Error("Choose a language before applying a translated variant.");
    return {...project,variants:[...project.variants,{id:crypto.randomUUID(),language,source}]};
  }
  return {...project,source,cast:applySuggestedCast(project.cast,value)};
}

export function speechProposalDiff(before: string, after: string): { unchanged: string; removed: string; added: string; trailing: string } {
  const original = Array.from(before), proposed = Array.from(after);
  let start = 0, end = 0;
  while (start < original.length && start < proposed.length && original[start] === proposed[start]) start++;
  while (end < original.length - start && end < proposed.length - start && original[original.length - end - 1] === proposed[proposed.length - end - 1]) end++;
  return { unchanged: original.slice(0, start).join(""), removed: original.slice(start, original.length - end).join(""), added: proposed.slice(start, proposed.length - end).join(""), trailing: original.slice(original.length - end).join("") };
}
