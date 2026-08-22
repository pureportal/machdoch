import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseRalphFlowRecord } from "./parse-ralph-flow-record.helper.js";
import type { RalphFlow } from "../ralph.js";
import type { TaskExecutionResult } from "../types.js";

export type GeneratedRalphFlowSource =
  | "file"
  | "tagged-response"
  | "fenced-response"
  | "raw-response";

export interface GeneratedRalphFlowReadResult {
  flow?: RalphFlow;
  source?: GeneratedRalphFlowSource;
  error?: string;
}

interface GeneratedRalphFlowJsonCandidate {
  source: Exclude<GeneratedRalphFlowSource, "file">;
  raw: string;
}

const RALPH_FLOW_JSON_TAG_PATTERN =
  /<ralph_flow_json>\s*([\s\S]*?)\s*<\/ralph_flow_json>/giu;
const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/giu;

const looksLikeRalphFlowJsonText = (value: string): boolean => {
  const text = value.trim();

  return (
    text.includes('"schemaVersion"') &&
    text.includes('"blocks"') &&
    text.includes('"edges"')
  );
};

const getGenerationResultTextCandidates = (
  result: TaskExecutionResult,
): string[] => {
  const candidates = [
    result.response?.markdown,
    ...result.outputSections.map((section) => section.lines.join("\n")),
    result.summary,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const seen = new Set<string>();
  const uniqueCandidates: string[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    uniqueCandidates.push(candidate);
  }

  return uniqueCandidates;
};

const extractGeneratedRalphFlowJsonCandidates = (
  text: string,
): GeneratedRalphFlowJsonCandidate[] => {
  const candidates: GeneratedRalphFlowJsonCandidate[] = [];

  for (const match of text.matchAll(RALPH_FLOW_JSON_TAG_PATTERN)) {
    const raw = match[1]?.trim();

    if (raw) {
      candidates.push({ source: "tagged-response", raw });
    }
  }

  for (const match of text.matchAll(FENCED_JSON_PATTERN)) {
    const raw = match[1]?.trim();

    if (raw && looksLikeRalphFlowJsonText(raw)) {
      candidates.push({ source: "fenced-response", raw });
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && looksLikeRalphFlowJsonText(trimmed)) {
    candidates.push({ source: "raw-response", raw: trimmed });
  }

  return candidates;
};

const tryParseGeneratedRalphFlowJson = (
  raw: string,
): { flow?: RalphFlow; error?: string } => {
  try {
    return { flow: parseRalphFlowRecord(JSON.parse(raw) as unknown) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const readGeneratedRalphFlow = async (
  generationFlowPath: string,
  result: TaskExecutionResult,
): Promise<GeneratedRalphFlowReadResult> => {
  const errors: string[] = [];

  for (const text of getGenerationResultTextCandidates(result)) {
    for (const candidate of extractGeneratedRalphFlowJsonCandidates(text)) {
      const parsed = tryParseGeneratedRalphFlowJson(candidate.raw);

      if (parsed.flow) {
        return { flow: parsed.flow, source: candidate.source };
      }

      errors.push(
        `Generator ${candidate.source} JSON was invalid: ${parsed.error ?? "unknown error"}`,
      );
    }
  }

  if (existsSync(generationFlowPath)) {
    const parsed = tryParseGeneratedRalphFlowJson(
      await readFile(generationFlowPath, "utf8"),
    );

    if (parsed.flow) {
      return { flow: parsed.flow, source: "file" };
    }

    errors.push(
      `Generated file was not valid Ralph JSON: ${parsed.error ?? "unknown error"}`,
    );
  }

  return {
    error:
      errors.length > 0
        ? errors.join(" ")
        : "The generator did not create a parseable Ralph flow JSON object in its file output or final response.",
  };
};
