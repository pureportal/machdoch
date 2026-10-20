import { validatePhonemes, type PhonemeAlphabet, type SourceRange } from "./script.ts";

export interface PronunciationRule {
  id: string;
  text: string;
  phonemes: string;
  alphabet: PhonemeAlphabet;
  caseSensitive: boolean;
}
export interface PronunciationDictionary { id: string; revision: string; name: string; rules: PronunciationRule[] }
export interface PronunciationMatch { from: number; to: number; ruleId: string; dictionaryId: string; revision: string; original: string; phonemes: string }
export interface DictionaryIssue { dictionaryId: string; ruleId?: string; message: string }
const asciiFold = (value: string): string => value.replace(/[A-Z]/gu, character => character.toLowerCase());

export function validateDictionaries(dictionaries: ReadonlyArray<PronunciationDictionary>): DictionaryIssue[] {
  const issues: DictionaryIssue[] = [];
  if (dictionaries.length > 3) issues.push({ dictionaryId: "", message: "Use up to three dictionaries per Fish request." });
  const known = new Map<string, PronunciationRule>();
  for (const dictionary of dictionaries) {
    if (!dictionary.revision) issues.push({ dictionaryId: dictionary.id, message: "Save a dictionary revision before rendering." });
    if (dictionary.rules.length > 5000) issues.push({ dictionaryId: dictionary.id, message: "Use up to 5,000 items per dictionary." });
    const ids = new Set<string>();
    for (const rule of dictionary.rules) {
      const issue = (message: string): void => { issues.push({ dictionaryId: dictionary.id, ruleId: rule.id, message }); };
      if (ids.has(rule.id)) issue("Give each rule a unique ID.");
      ids.add(rule.id);
      if (!rule.text.trim() || /[<>[\]]|\p{Cc}/u.test(rule.text)) issue("Use nonempty literal text without performance controls.");
      if (Array.from(rule.text).length > 256 || Array.from(rule.phonemes).length > 1024) issue("Use keys up to 256 characters and phonemes up to 1,024 characters.");
      if (!validatePhonemes(rule.phonemes, rule.alphabet)) issue(`Use valid ${rule.alphabet} phonemes.`);
      const key = rule.caseSensitive ? rule.text : asciiFold(rule.text);
      const previous = known.get(key);
      if (previous && (previous.phonemes !== rule.phonemes || previous.alphabet !== rule.alphabet)) issue("This rule conflicts with an earlier pronunciation.");
      known.set(key, rule);
    }
  }
  return issues;
}

export function previewPronunciation(source: string, dictionaries: ReadonlyArray<PronunciationDictionary>, range: SourceRange = {from:0,to:source.length}): PronunciationMatch[] {
  if(!Number.isSafeInteger(range.from)||!Number.isSafeInteger(range.to)||range.from<0||range.to<range.from||range.to>source.length)throw new Error("Choose a pronunciation preview range within the text.");
  const issues = validateDictionaries(dictionaries);
  if (issues.length) throw new Error(issues.map(issue => issue.message).join(" "));
  if(range.from===range.to)return [];
  const matches: PronunciationMatch[] = [];
  interface Entry { dictionary: PronunciationDictionary; rule: PronunciationRule; order: number }
  interface Edge { text: string; next: Branch }
  interface Branch { children: Map<string, Edge>; entry?: Entry }
  const sensitive: Branch = { children: new Map() };
  const insensitive: Branch = { children: new Map() };
  let order = 0;
  for (const dictionary of dictionaries) for (const rule of dictionary.rules) {
    let branch = rule.caseSensitive ? sensitive : insensitive;
    let text = rule.caseSensitive ? rule.text : asciiFold(rule.text);
    while (text.length) {
      const character = text[0]!;
      const edge = branch.children.get(character);
      if (!edge) {
        const next: Branch = { children: new Map() };
        branch.children.set(character, { text, next }); branch = next; break;
      }
      let shared = 0;
      while (shared < text.length && shared < edge.text.length && text[shared] === edge.text[shared]) shared++;
      if (shared < edge.text.length) {
        const next: Branch = { children: new Map([[edge.text[shared]!, { text: edge.text.slice(shared), next: edge.next }]]) };
        branch.children.set(character, { text: edge.text.slice(0, shared), next });
        branch = next;
      } else branch = edge.next;
      text = text.slice(shared);
    }
    branch.entry ??= { dictionary, rule, order };
    order++;
  }
  const folded = asciiFold(source);
  let cursor = 0;
  while (cursor < range.to) {
    let best: { to: number; entry: Entry } | undefined;
    for (let tree = 0; tree < 2; tree++) {
      let branch = tree === 0 ? sensitive : insensitive;
      const text = tree === 0 ? source : folded;
      let end = cursor;
      while (end < text.length) {
        const edge = branch.children.get(text[end]!);
        if (!edge || !text.startsWith(edge.text, end)) break;
        end += edge.text.length; branch = edge.next;
        if (branch.entry && (!best || end > best.to || end === best.to && branch.entry.order < best.entry.order)) best = { to: end, entry: branch.entry };
      }
    }
    if (!best) { cursor++; continue; }
    const { dictionary, rule } = best.entry;
    if(best.to>range.from)matches.push({ from: cursor, to: best.to, original: source.slice(cursor, best.to), ruleId: rule.id, dictionaryId: dictionary.id, revision: dictionary.revision, phonemes: rule.phonemes });
    cursor = best.to;
  }
  return matches;
}
