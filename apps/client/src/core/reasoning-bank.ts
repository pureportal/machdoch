import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadWorkspaceConfigFile } from "./config.js";
import { tokenizeMemoryText } from "./memory-retrieval.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";

export type ReasoningOutcome = "success" | "failure";

export interface ReasoningLesson {
  id: string;
  title: string;
  description: string;
  content: string;
  triggerTerms: string[];
  outcome: ReasoningOutcome;
  confidence: number;
  evidenceCount: number;
  helpfulCount: number;
  harmfulCount: number;
  retrievalCount?: number;
  lastRetrievedAt?: number | undefined;
  createdAt: number;
  updatedAt: number;
}

export type ReasoningLessonCandidate = Pick<
  ReasoningLesson,
  | "title"
  | "description"
  | "content"
  | "triggerTerms"
  | "outcome"
  | "confidence"
>;

export interface ReasoningBankStore {
  load(): Promise<ReasoningLesson[]>;
  consolidate(
    candidates: ReasoningLessonCandidate[],
  ): Promise<ReasoningLesson[]>;
  recordOutcome(ids: string[], outcome: ReasoningOutcome): Promise<void>;
  recordRetrieval(ids: string[]): Promise<void>;
  forget(id: string): Promise<boolean>;
}

const BANK_VERSION = 1;
const MAX_LESSONS = 240;
const MAX_RETRIEVED = 4;
const MAX_CONTEXT_CHARACTERS = 1_600;

interface ReasoningBankDocument {
  version: typeof BANK_VERSION;
  lessons: ReasoningLesson[];
}

const isReasoningLessonCandidate = (
  value: unknown,
): value is ReasoningLessonCandidate => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReasoningLessonCandidate>;
  return (
    typeof candidate.title === "string" &&
    candidate.title.trim().length >= 4 &&
    candidate.title.length <= 90 &&
    typeof candidate.description === "string" &&
    candidate.description.trim().length >= 12 &&
    candidate.description.length <= 200 &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length >= 20 &&
    candidate.content.length <= 650 &&
    Array.isArray(candidate.triggerTerms) &&
    candidate.triggerTerms.length <= 8 &&
    candidate.triggerTerms.every(
      (term) =>
        typeof term === "string" &&
        term.trim().length >= 2 &&
        term.length <= 48,
    ) &&
    (candidate.outcome === "success" || candidate.outcome === "failure") &&
    typeof candidate.confidence === "number" &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0 &&
    candidate.confidence <= 1
  );
};

const isReasoningLesson = (value: unknown): value is ReasoningLesson => {
  if (!value || typeof value !== "object") return false;
  const lesson = value as Partial<ReasoningLesson>;
  return (
    typeof lesson.id === "string" &&
    typeof lesson.title === "string" &&
    typeof lesson.description === "string" &&
    typeof lesson.content === "string" &&
    Array.isArray(lesson.triggerTerms) &&
    lesson.triggerTerms.every((term) => typeof term === "string") &&
    (lesson.outcome === "success" || lesson.outcome === "failure") &&
    typeof lesson.confidence === "number" &&
    Number.isFinite(lesson.confidence) &&
    lesson.confidence >= 0 &&
    lesson.confidence <= 1 &&
    typeof lesson.evidenceCount === "number" &&
    Number.isSafeInteger(lesson.evidenceCount) &&
    lesson.evidenceCount > 0 &&
    typeof lesson.helpfulCount === "number" &&
    Number.isSafeInteger(lesson.helpfulCount) &&
    lesson.helpfulCount >= 0 &&
    typeof lesson.harmfulCount === "number" &&
    Number.isSafeInteger(lesson.harmfulCount) &&
    lesson.harmfulCount >= 0 &&
    (lesson.retrievalCount === undefined ||
      (Number.isSafeInteger(lesson.retrievalCount) &&
        lesson.retrievalCount >= 0)) &&
    (lesson.lastRetrievedAt === undefined ||
      (typeof lesson.lastRetrievedAt === "number" &&
        Number.isFinite(lesson.lastRetrievedAt))) &&
    typeof lesson.createdAt === "number" &&
    Number.isFinite(lesson.createdAt) &&
    typeof lesson.updatedAt === "number" &&
    Number.isFinite(lesson.updatedAt)
  );
};

export const getReasoningBankPath = (workspaceRoot: string): string =>
  join(resolve(workspaceRoot), ".machdoch", "reasoning-bank.json");

export const isReasoningBankEnabled = async (
  workspaceRoot: string,
  workspaceSelected = true,
): Promise<boolean> => {
  if (!workspaceSelected) return false;
  const { config } = await loadWorkspaceConfigFile(workspaceRoot);
  return config.reasoningBankEnabled !== false;
};

const loadDocument = async (path: string): Promise<ReasoningBankDocument> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { version: BANK_VERSION, lessons: [] };
    }
    throw error;
  }

  const document: unknown = JSON.parse(raw);
  if (
    !document ||
    typeof document !== "object" ||
    !("version" in document) ||
    !("lessons" in document) ||
    document.version !== BANK_VERSION ||
    !Array.isArray(document.lessons) ||
    !document.lessons.every(isReasoningLesson)
  ) {
    throw new Error(`Unsupported ReasoningBank document in ${path}.`);
  }
  return document as ReasoningBankDocument;
};

const lessonKey = (
  lesson: Pick<ReasoningLesson, "title" | "outcome">,
): string =>
  `${lesson.outcome}:${lesson.title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")}`;

const trimBank = (lessons: ReasoningLesson[]): ReasoningLesson[] =>
  lessons
    .sort(
      (left, right) =>
        right.confidence +
          right.helpfulCount * 0.08 -
          right.harmfulCount * 0.12 -
          (left.confidence +
            left.helpfulCount * 0.08 -
            left.harmfulCount * 0.12) || right.updatedAt - left.updatedAt,
    )
    .slice(0, MAX_LESSONS);

export const createLocalReasoningBank = (
  workspaceRoot: string,
): ReasoningBankStore => {
  const path = getReasoningBankPath(workspaceRoot);

  return {
    load: async () => (await loadDocument(path)).lessons,
    consolidate: async (candidates) => {
      if (candidates.length === 0) return [];
      if (!candidates.every(isReasoningLessonCandidate)) {
        throw new Error("Invalid ReasoningBank lesson candidate.");
      }
      const uniqueCandidates = new Map<string, ReasoningLessonCandidate>();
      for (const candidate of candidates) {
        const key = lessonKey(candidate);
        const previous = uniqueCandidates.get(key);
        if (!previous || candidate.confidence > previous.confidence) {
          uniqueCandidates.set(key, candidate);
        }
      }
      const stored: ReasoningLesson[] = [];
      let retainedIds = new Set<string>();
      await withCooperativeFileLock(path, async () => {
        const document = await loadDocument(path);
        const lessons = [...document.lessons];
        const now = Date.now();
        for (const candidate of uniqueCandidates.values()) {
          const key = lessonKey(candidate);
          const index = lessons.findIndex((entry) => lessonKey(entry) === key);
          if (index >= 0) {
            const previous = lessons[index]!;
            const useNewContent =
              candidate.confidence >= previous.confidence - 0.05 ||
              previous.harmfulCount > previous.helpfulCount;
            const contentChanged =
              useNewContent && candidate.content !== previous.content;
            const updated: ReasoningLesson = {
              ...previous,
              id: contentChanged ? randomUUID() : previous.id,
              description: useNewContent
                ? candidate.description
                : previous.description,
              content: useNewContent ? candidate.content : previous.content,
              triggerTerms: contentChanged
                ? candidate.triggerTerms.slice(0, 12)
                : useNewContent
                  ? Array.from(
                      new Set([
                        ...previous.triggerTerms,
                        ...candidate.triggerTerms,
                      ]),
                    ).slice(0, 12)
                  : previous.triggerTerms,
              confidence: contentChanged
                ? candidate.confidence
                : Math.min(
                    0.98,
                    Math.max(previous.confidence, candidate.confidence) + 0.04,
                  ),
              evidenceCount: contentChanged ? 1 : previous.evidenceCount + 1,
              helpfulCount: contentChanged ? 0 : previous.helpfulCount,
              harmfulCount: contentChanged ? 0 : previous.harmfulCount,
              retrievalCount: contentChanged
                ? 0
                : (previous.retrievalCount ?? 0),
              lastRetrievedAt: contentChanged
                ? undefined
                : previous.lastRetrievedAt,
              createdAt: contentChanged ? now : previous.createdAt,
              updatedAt: now,
            };
            lessons[index] = updated;
            stored.push(updated);
          } else {
            const created: ReasoningLesson = {
              ...candidate,
              id: randomUUID(),
              evidenceCount: 1,
              helpfulCount: 0,
              harmfulCount: 0,
              retrievalCount: 0,
              createdAt: now,
              updatedAt: now,
            };
            lessons.push(created);
            stored.push(created);
          }
        }
        const retained = trimBank(lessons);
        retainedIds = new Set(retained.map((lesson) => lesson.id));
        await writeJsonAtomically(path, {
          version: BANK_VERSION,
          lessons: retained,
        } satisfies ReasoningBankDocument);
      });
      return stored.filter((lesson) => retainedIds.has(lesson.id));
    },
    recordOutcome: async (ids, outcome) => {
      if (ids.length === 0) return;
      const selected = new Set(ids);
      await withCooperativeFileLock(path, async () => {
        const document = await loadDocument(path);
        let changed = false;
        const lessons = document.lessons.map((lesson) => {
          if (!selected.has(lesson.id)) return lesson;
          changed = true;
          return {
            ...lesson,
            helpfulCount: lesson.helpfulCount + (outcome === "success" ? 1 : 0),
            harmfulCount: lesson.harmfulCount + (outcome === "failure" ? 1 : 0),
          };
        });
        if (changed) {
          await writeJsonAtomically(path, {
            version: BANK_VERSION,
            lessons,
          } satisfies ReasoningBankDocument);
        }
      });
    },
    recordRetrieval: async (ids) => {
      if (ids.length === 0) return;
      const selected = new Set(ids);
      await withCooperativeFileLock(path, async () => {
        const document = await loadDocument(path);
        const now = Date.now();
        let changed = false;
        const lessons = document.lessons.map((lesson) => {
          if (!selected.has(lesson.id)) return lesson;
          changed = true;
          return {
            ...lesson,
            retrievalCount: (lesson.retrievalCount ?? 0) + 1,
            lastRetrievedAt: now,
          };
        });
        if (changed) {
          await writeJsonAtomically(path, {
            version: BANK_VERSION,
            lessons,
          } satisfies ReasoningBankDocument);
        }
      });
    },
    forget: async (id) => {
      let removed = false;
      await withCooperativeFileLock(path, async () => {
        const document = await loadDocument(path);
        const lessons = document.lessons.filter((entry) => entry.id !== id);
        removed = lessons.length !== document.lessons.length;
        if (removed) {
          await writeJsonAtomically(path, {
            version: BANK_VERSION,
            lessons,
          } satisfies ReasoningBankDocument);
        }
      });
      return removed;
    },
  };
};

export const retrieveReasoningLessons = (
  query: string,
  lessons: ReasoningLesson[],
  options: { maxLessons?: number; maxCharacters?: number } = {},
): ReasoningLesson[] => {
  const queryTokens = new Set(tokenizeMemoryText(query));
  if (queryTokens.size === 0) return [];
  const now = Date.now();
  const documents = lessons
    .filter((lesson) => lesson.harmfulCount <= lesson.helpfulCount)
    .map((lesson) => ({
      lesson,
      title: new Set(tokenizeMemoryText(lesson.title)),
      description: new Set(tokenizeMemoryText(lesson.description)),
      content: new Set(tokenizeMemoryText(lesson.content)),
      triggers: new Set(tokenizeMemoryText(lesson.triggerTerms.join(" "))),
    }));
  const documentFrequencies = new Map(
    [...queryTokens].map((token) => [
      token,
      documents.filter(
        (document) =>
          document.title.has(token) ||
          document.triggers.has(token) ||
          document.description.has(token) ||
          document.content.has(token),
      ).length,
    ]),
  );
  const ranked = documents
    .map(({ lesson, title, description, content, triggers }) => {
      let relevance = 0;
      let matchedTokens = 0;
      for (const token of queryTokens) {
        const fieldWeight =
          (title.has(token) ? 3 : 0) +
          (triggers.has(token) ? 2 : 0) +
          (description.has(token) ? 1.5 : 0) +
          (content.has(token) ? 0.4 : 0);
        if (fieldWeight === 0) continue;
        matchedTokens += 1;
        const frequency = documentFrequencies.get(token) ?? 0;
        const rarity = Math.log(
          1 + (documents.length - frequency + 0.5) / (frequency + 0.5),
        );
        relevance += rarity * fieldWeight;
      }
      const quality =
        lesson.confidence +
        Math.log1p(lesson.evidenceCount) * 0.1 +
        lesson.helpfulCount * 0.06 -
        lesson.harmfulCount * 0.12;
      const recency = Math.exp(
        (-Math.LN2 * Math.max(0, now - lesson.updatedAt)) / (180 * 86_400_000),
      );
      return {
        lesson,
        score:
          relevance *
            Math.max(0.1, quality) *
            (0.6 + (0.4 * matchedTokens) / queryTokens.size) +
          (matchedTokens > 0 ? recency * 0.15 : 0),
      };
    })
    .filter(({ score }) => score >= 0.8)
    .sort((left, right) => right.score - left.score);

  const selected: ReasoningLesson[] = [];
  let characters = 0;
  for (const { lesson } of ranked) {
    const length = lesson.title.length + lesson.content.length + 40;
    if (
      selected.length >= (options.maxLessons ?? MAX_RETRIEVED) ||
      characters + length > (options.maxCharacters ?? MAX_CONTEXT_CHARACTERS)
    ) {
      continue;
    }
    selected.push(lesson);
    characters += length;
  }
  return selected;
};
