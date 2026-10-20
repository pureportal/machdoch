import { validateDictionaries, type SpeechDictionary } from "@machdoch/speech";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readDictionaryFile(file: File): Promise<SpeechDictionary> {
  if(file.size>16*1024*1024)throw new Error("Choose dictionary JSON below the local 16 MiB import limit.");
  const content = await file.text();
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Invalid JSON. Choose a dictionary JSON file.");
  }
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.revision !== "string"
    || typeof value.name !== "string" || !Array.isArray(value.rules)) {
    throw new Error("Invalid dictionary. Include id, revision, name and a rules array.");
  }
  if (!value.name.trim()) throw new Error("Add a dictionary name to the JSON file and import it again.");
  if (value.rules.length > 5000) throw new Error("Reduce the JSON dictionary to at most 5,000 rules and import it again.");

  const rules: SpeechDictionary["rules"] = value.rules.map((rule: unknown, index: number) => {
    if (!isRecord(rule) || typeof rule.id !== "string" || !rule.id.trim()
      || typeof rule.text !== "string" || typeof rule.phonemes !== "string"
      || typeof rule.caseSensitive !== "boolean"
      || (rule.alphabet !== "arpabet" && rule.alphabet !== "pinyin" && rule.alphabet !== "romaji")) {
      throw new Error("Invalid rule " + (index + 1) + ". Include a nonempty id, text, phonemes, a supported alphabet and a boolean caseSensitive.");
    }
    return {
      id: rule.id,
      text: rule.text,
      phonemes: rule.phonemes,
      alphabet: rule.alphabet,
      caseSensitive: rule.caseSensitive,
    };
  });

  const dictionary = { id: crypto.randomUUID(), revision: "", name: value.name.trim(), rules };
  const positions = new Map(rules.map((rule, index) => [rule.id, index + 1]));
  const errors = validateDictionaries([dictionary]).flatMap(issue => issue.ruleId === undefined
    ? [] : ["Rule " + positions.get(issue.ruleId) + ": " + issue.message]);
  if (errors.length) throw new Error(errors.join(" "));
  return dictionary;
}

export function downloadDictionary(dictionary: SpeechDictionary): void {
  const blob = new Blob([JSON.stringify(dictionary, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = dictionary.name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "-").replace(/[. ]+$/u, "") + ".json";
  link.hidden = true;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
