import type { SpeechProject } from "./runtime.ts";
import { parseSpeechScript, type SpeechDiagnostic } from "./script.ts";

export interface DialogueTable {
  source: string;
  delimiter: "," | "\t";
  rows: string[][];
  diagnostics: SpeechDiagnostic[];
}

export interface SpeechImportResult {
  source: string;
  diagnostics: SpeechDiagnostic[];
}

export interface DialogueMapping {
  textColumn: number;
  speakerColumn: number;
  castBindings: Readonly<Record<string, string>>;
}

export function parseDialogueTable(source: string, delimiter: "," | "\t"): DialogueTable {
  if (delimiter !== "," && delimiter !== "\t") throw new Error("Choose CSV or TSV.");
  const rows: string[][] = [];
  const diagnostics: SpeechDiagnostic[] = [];
  let row: string[] = [];
  let field = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let quoteStart = 0;
  let rowStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cursor = rowStart;
  const error = (from: number, to: number, code: string, message: string): void => {
    diagnostics.push({ from, to, code, message, severity: "error" });
  };
  const finishRow = (end: number): void => {
    if(rows.length>=10001)throw new Error("Keep dialogue imports within the local 10,000-row guard plus one header row.");
    if(row.length>=256)throw new Error("Keep dialogue imports within the local 256-column guard.");
    row.push(field);
    if (rows.length && row.length !== rows[0]!.length) {
      error(rowStart, end, "column-count", "Row " + (rows.length + 1) + " has " + row.length + " columns; expected " + rows[0]!.length + ".");
    }
    rows.push(row);
    row = [];
    field = "";
    state = "start";
  };
  while (cursor < source.length) {
    const character = source[cursor];
    if (state === "quoted") {
      if (character === '"') {
        if (source[cursor + 1] === '"') {
          field += '"';
          cursor += 2;
          continue;
        }
        state = "closed";
      } else {
        field += character;
      }
      cursor++;
      continue;
    }
    if (character === delimiter) {
      if(row.length>=255)throw new Error("Keep dialogue imports within the local 256-column guard.");
      row.push(field);
      field = "";
      state = "start";
      cursor++;
      continue;
    }
    if (character === "\r" || character === "\n") {
      finishRow(cursor);
      cursor += character === "\r" && source[cursor + 1] === "\n" ? 2 : 1;
      rowStart = cursor;
      continue;
    }
    if (state === "closed") {
      error(cursor, cursor + 1, "characters-after-quote", "Remove the character after the closing quote in row " + (rows.length + 1) + ".");
      state = "plain";
    }
    if (character === '"') {
      if (state === "start") {
        state = "quoted";
        quoteStart = cursor;
      } else {
        error(cursor, cursor + 1, "unexpected-quote", "Quote the whole field and double embedded quotes in row " + (rows.length + 1) + ".");
        field += character;
      }
    } else {
      state = "plain";
      field += character;
    }
    cursor++;
  }
  if (state === "quoted") error(quoteStart, source.length, "unclosed-quote", "Close the quoted field in row " + (rows.length + 1) + ".");
  if (rowStart < source.length) finishRow(source.length);
  return { source, delimiter, rows, diagnostics };
}

function literalSpeechText(value: string): string {
  const parsed = parseSpeechScript(value);
  if (parsed.diagnostics.length || parsed.nodes.some(node => node.kind !== "text")) {
    throw new Error("Use literal text without speech controls or structural markup.");
  }
  return value;
}

export function importDialogue(rows: ReadonlyArray<ReadonlyArray<string>>, mapping: DialogueMapping): SpeechImportResult {
  const diagnostics: SpeechDiagnostic[] = [];
  const lines: string[] = [];
  if (!Number.isInteger(mapping.textColumn) || mapping.textColumn < 0 ||
      !Number.isInteger(mapping.speakerColumn) || mapping.speakerColumn < 0 ||
      mapping.textColumn === mapping.speakerColumn) {
    return { source: "", diagnostics: [{ from: 0, to: 0, severity: "error", code: "column-mapping", message: "Choose different text and speaker columns." }] };
  }
  if (!rows.length) {
    return { source: "", diagnostics: [{ from: 0, to: 0, severity: "error", code: "empty-dialogue", message: "Add at least one dialogue row." }] };
  }
  rows.forEach((row, index) => {
    const error = (code: string, message: string): void => {
      diagnostics.push({ from: index, to: index + 1, severity: "error", code, message: "Row " + (index + 1) + ": " + message });
    };
    const text = row[mapping.textColumn];
    const speaker = row[mapping.speakerColumn];
    if (text === undefined || speaker === undefined) {
      error("missing-column", "Choose columns present in every row.");
      return;
    }
    if (!text.trim()) {
      error("empty-text", "Enter dialogue text.");
      return;
    }
    const castId = Object.hasOwn(mapping.castBindings, speaker) ? mapping.castBindings[speaker] : undefined;
    if (!speaker.trim() || !castId) {
      error("missing-cast", "Map " + (speaker || "the empty speaker") + " to an existing cast member.");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/u.test(castId)) {
      error("invalid-cast-id", "Choose a cast member with a valid stable ID.");
      return;
    }
    try {
      lines.push("<|speaker:" + castId + "|>" + literalSpeechText(text));
    } catch (failure) {
      error("dialogue-controls", failure instanceof Error ? failure.message : "Remove speech controls from the dialogue field.");
    }
  });
  return { source: diagnostics.length ? "" : lines.join("\n"), diagnostics };
}

export interface SpeechTemplateVariable {
  name: string;
  from: number;
  to: number;
}

export interface SpeechTemplate {
  source: string;
  variables: SpeechTemplateVariable[];
  diagnostics: SpeechDiagnostic[];
}

export function parseSpeechTemplate(source: string): SpeechTemplate {
  const variables: SpeechTemplateVariable[] = [];
  const diagnostics: SpeechDiagnostic[] = [];
  const pattern = /\{\{|\}\}/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const from = match.index;
    const closing = source.indexOf("}}", from + 2);
    if (match[0] === "}}" || closing < 0) {
      diagnostics.push({ from, to: from + 2, severity: "error", code: "template-braces", message: "Use {{name}} for each template variable." });
      continue;
    }
    const name = source.slice(from + 2, closing).trim();
    if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(name)) {
      diagnostics.push({ from, to: closing + 2, severity: "error", code: "template-name", message: "Use a variable name beginning with a letter or underscore." });
    } else {
      variables.push({ name, from, to: closing + 2 });
    }
    pattern.lastIndex = closing + 2;
  }
  return { source, variables, diagnostics };
}

export function validateSpeechTemplate(source: string, values: Readonly<Record<string, string>>): SpeechTemplate {
  const template = parseSpeechTemplate(source);
  const script = parseSpeechScript(source);
  const diagnostics = [...template.diagnostics, ...script.diagnostics];
  for (const variable of template.variables) {
    const error = (code: string, message: string): void => {
      diagnostics.push({ from: variable.from, to: variable.to, severity: "error", code, message });
    };
    if (!script.nodes.some(node => node.kind === "text" && node.from <= variable.from && node.to >= variable.to)) {
      error("template-control-context", "Place " + variable.name + " in spoken text, outside speech controls and metadata.");
    }
    if (!Object.hasOwn(values, variable.name) || typeof values[variable.name] !== "string") {
      error("template-missing-value", "Provide a value for " + variable.name + ".");
      continue;
    }
    try {
      literalSpeechText(values[variable.name]!);
    } catch {
      error("template-control-value", "Remove speech controls and structural markup from " + variable.name + ".");
    }
  }
  return { ...template, diagnostics };
}

export function resolveSpeechTemplate(source: string, values: Readonly<Record<string, string>>): SpeechImportResult {
  const template = validateSpeechTemplate(source, values);
  if (template.diagnostics.length) return { source: "", diagnostics: template.diagnostics };
  let resolved = "";
  let cursor = 0;
  for (const variable of template.variables) {
    resolved += source.slice(cursor, variable.from) + values[variable.name];
    cursor = variable.to;
  }
  resolved += source.slice(cursor);
  const resolvedScript = parseSpeechScript(resolved);
  const controls = (text: string): string[] => parseSpeechScript(text).nodes.filter(node => node.kind !== "text").map(node => node.raw);
  const diagnostics = [...resolvedScript.diagnostics];
  if (JSON.stringify(controls(source)) !== JSON.stringify(controls(resolved))) {
    diagnostics.push({ from: 0, to: source.length, severity: "error", code: "template-control-injection", message: "Keep template variables from creating speech controls or structural markup." });
  }
  return { source: diagnostics.length ? "" : resolved, diagnostics };
}

export function importSpeechDocument(
  originalSource: string,
  options: { format: "text" | "markdown"; stripStructuralMetadata?: boolean },
): SpeechImportResult & { originalSource: string } {
  if (options.format !== "markdown" || !options.stripStructuralMetadata) {
    return { originalSource, source: originalSource, diagnostics: [] };
  }
  let source = originalSource;
  const frontMatter = /^(?:\uFEFF)?---(?:\r\n|\n|\r)[\s\S]*?(?:\r\n|\n|\r)(?:---|\.\.\.)(?:\r\n|\n|\r|$)/u;
  if (/^(?:\uFEFF)?---(?:\r\n|\n|\r)/u.test(source) && !frontMatter.test(source)) {
    return { originalSource, source: originalSource, diagnostics: [{ from: 0, to: source.length, severity: "error", code: "unclosed-front-matter", message: "Close the Markdown front matter before importing." }] };
  }
  source = source.replace(frontMatter, "");
  const comments = parseSpeechScript(source).nodes.filter(node => node.kind === "comment");
  if (comments.some(node => !node.raw.endsWith("-->"))) {
    return { originalSource, source: originalSource, diagnostics: [{ from: 0, to: originalSource.length, severity: "error", code: "unclosed-comment", message: "Close the Markdown comment before importing." }] };
  }
  for (const comment of comments.reverse()) source = source.slice(0, comment.from) + source.slice(comment.to);
  return { originalSource, source, diagnostics: [] };
}

type ProjectVariant = SpeechProject["variants"][number];

function validateVariant(variant: ProjectVariant): ProjectVariant {
  if (!variant.id.trim()) throw new Error("Provide a variant ID.");
  let languages: string[];
  try {
    languages = Intl.getCanonicalLocales(variant.language);
  } catch {
    throw new Error("Enter a valid language tag, such as de-DE.");
  }
  if (languages.length !== 1) throw new Error("Enter a language tag.");
  return { ...variant, language: languages[0]! };
}

export function createProjectVariant(project: SpeechProject, variant: ProjectVariant): SpeechProject {
  const validated = validateVariant(variant);
  if (project.variants.some(item => item.id === validated.id)) throw new Error("Use a unique variant ID.");
  return { ...project, variants: [...project.variants, validated] };
}

export function copyProjectVariant(
  project: SpeechProject,
  variantId: string | null,
  target: { id: string; language: string },
): SpeechProject {
  const variant = variantId === null ? null : project.variants.find(item => item.id === variantId);
  if (variantId !== null && !variant) throw new Error("Choose an existing variant.");
  return createProjectVariant(project, { ...target, source: variant ? variant.source : project.source });
}

export function updateProjectVariant(project: SpeechProject, variant: ProjectVariant): SpeechProject {
  if (!project.variants.some(item => item.id === variant.id)) throw new Error("Choose an existing variant.");
  const validated = validateVariant(variant);
  return { ...project, variants: project.variants.map(item => item.id === validated.id ? validated : item) };
}

export interface ReadingSentence {
  text: string;
  source: string;
  from: number;
  to: number;
}

export function readingSentences(source: string): ReadingSentence[] {
  const sentences: ReadingSentence[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const deliveryTags: string[] = [];
  let speaker = "";
  let direction = "";
  for (const node of parseSpeechScript(source).nodes) {
    if (node.kind === "speaker") {
      speaker = node.raw;
      direction = "";
    }
    if (node.kind === "direction") direction = node.raw;
    if (node.kind === "openTag") deliveryTags.push(node.value);
    if (node.kind === "closeTag" && deliveryTags.at(-1) === node.value) deliveryTags.pop();
    if (node.kind === "chapter" || node.kind === "scene") direction = "";
    if (node.kind !== "text") continue;
    for (const segment of segmenter.segment(node.value)) {
      const text = segment.segment.trim();
      if (!text) continue;
      const from = node.from + segment.index + segment.segment.indexOf(text);
      const opening = deliveryTags.map(tag => "<" + tag + ">").join("");
      const closing = [...deliveryTags].reverse().map(tag => "</" + tag + ">").join("");
      sentences.push({ text, source: speaker + direction + opening + text + closing, from, to: from + text.length });
    }
  }
  return sentences;
}
