import type {
  ConversationMemoryEntry,
  ConversationMemoryScope,
} from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "create",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "with",
  "you",
]);

const SCOPE_QUOTAS: Record<ConversationMemoryScope, number> = {
  session: 3,
  workspace: 4,
  global: 2,
};

const SCOPE_RECENCY_HALF_LIFE_DAYS: Record<ConversationMemoryScope, number> = {
  session: 7,
  workspace: 90,
  global: 365,
};

export interface RankedMemoryEntry {
  entry: ConversationMemoryEntry;
  score: number;
  reasons: string[];
}

export interface MemoryRetrievalResult {
  entries: ConversationMemoryEntry[];
  ranked: RankedMemoryEntry[];
  diagnostics: {
    candidateCount: number;
    selectedCount: number;
    selectedByScope: Record<ConversationMemoryScope, number>;
    contextCharacters: number;
    selectionSignals: string[];
  };
}

export interface MemoryRetrievalOptions {
  maxEntries?: number;
  maxCharacters?: number;
  minimumScore?: number;
  now?: number;
}

export const tokenizeMemoryText = (value: string): string[] => {
  const expanded = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .toLowerCase();

  return Array.from(expanded.matchAll(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu))
    .map((match) => match[0]?.replace(/^[-/._]+|[-/._]+$/gu, "") ?? "")
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
};

const countTokens = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
};

const createBigrams = (tokens: string[]): Set<string> => {
  return new Set(
    tokens.slice(1).map((token, index) => `${tokens[index]} ${token}`),
  );
};

const calculateRecency = (
  entry: ConversationMemoryEntry,
  now: number,
): number => {
  const ageDays = Math.max(0, now - entry.updatedAt) / 86_400_000;
  const halfLife = SCOPE_RECENCY_HALF_LIFE_DAYS[entry.scope];
  return Math.exp((-Math.LN2 * ageDays) / halfLife);
};

const createEmptyScopeCounts = (): Record<ConversationMemoryScope, number> => ({
  session: 0,
  workspace: 0,
  global: 0,
});

export const retrieveConversationMemory = (
  query: string,
  entries: ConversationMemoryEntry[],
  options: MemoryRetrievalOptions = {},
): MemoryRetrievalResult => {
  const maxEntries = options.maxEntries ?? 8;
  const maxCharacters = options.maxCharacters ?? 1_800;
  const minimumScore = options.minimumScore ?? 0.2;
  const now = options.now ?? Date.now();
  const queryTokens = tokenizeMemoryText(query);
  const queryCounts = countTokens(queryTokens);
  const queryBigrams = createBigrams(queryTokens);
  const documents = entries.map((entry) => {
    const searchTermTokens = tokenizeMemoryText(entry.searchTerms.join(" "));
    const tokens = tokenizeMemoryText(
      `${entry.key} ${entry.content} ${entry.searchTerms.join(" ")}`,
    );
    return {
      entry,
      tokens,
      counts: countTokens(tokens),
      searchTermTokens: new Set(searchTermTokens),
    };
  });
  const averageDocumentLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) /
    Math.max(1, documents.length);
  const documentFrequencies = new Map<string, number>();

  for (const token of queryCounts.keys()) {
    documentFrequencies.set(
      token,
      documents.filter((document) => document.counts.has(token)).length,
    );
  }

  const ranked = documents
    .map(({ entry, tokens, counts, searchTermTokens }): RankedMemoryEntry => {
      let bm25 = 0;
      let matchedQueryTokens = 0;

      for (const [token, queryFrequency] of queryCounts) {
        const termFrequency = counts.get(token) ?? 0;

        if (termFrequency === 0) {
          continue;
        }

        matchedQueryTokens += 1;
        const documentFrequency = documentFrequencies.get(token) ?? 0;
        const inverseDocumentFrequency = Math.log(
          1 +
            (documents.length - documentFrequency + 0.5) /
              (documentFrequency + 0.5),
        );
        const lengthNormalization =
          1.2 *
          (0.25 + (0.75 * tokens.length) / Math.max(1, averageDocumentLength));
        bm25 +=
          queryFrequency *
          inverseDocumentFrequency *
          ((termFrequency * 2.2) / (termFrequency + lengthNormalization));
      }

      const lexicalScore = bm25 / (bm25 + 3);
      const documentBigrams = createBigrams(tokens);
      const matchingBigrams = Array.from(queryBigrams).filter((bigram) =>
        documentBigrams.has(bigram),
      ).length;
      const phraseScore =
        queryBigrams.size > 0 ? matchingBigrams / queryBigrams.size : 0;
      const coverageScore =
        queryCounts.size > 0 ? matchedQueryTokens / queryCounts.size : 0;
      const matchingSearchTerms = Array.from(queryCounts.keys()).filter(
        (token) => searchTermTokens.has(token),
      ).length;
      const expandedKeyScore =
        matchingSearchTerms > 0
          ? Math.min(
              1,
              0.5 + matchingSearchTerms / Math.max(1, queryCounts.size),
            )
          : 0;
      const recencyScore = calculateRecency(entry, now);
      const importanceScore = (entry.importance - 1) / 4;
      const scopeRecencyWeight = entry.scope === "session" ? 0.08 : 0.03;
      const generalPreferenceWeight =
        entry.kind === "preference" && entry.scope === "global" ? 0.05 : 0;
      const score =
        lexicalScore * 0.57 +
        coverageScore * 0.12 +
        phraseScore * 0.1 +
        expandedKeyScore * 0.1 +
        recencyScore * scopeRecencyWeight +
        importanceScore * 0.06 +
        entry.confidence * 0.04 +
        generalPreferenceWeight;
      const reasons = [
        ...(matchedQueryTokens > 0 ? ["lexical"] : []),
        ...(matchingBigrams > 0 ? ["phrase"] : []),
        ...(matchingSearchTerms > 0 ? ["expanded-key"] : []),
        ...(recencyScore >= 0.5 ? ["recent"] : []),
        ...(importanceScore >= 0.75 ? ["important"] : []),
        ...(generalPreferenceWeight > 0 ? ["global-preference"] : []),
      ];

      return { entry, score, reasons };
    })
    .filter((candidate) => candidate.score >= minimumScore)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.updatedAt - left.entry.updatedAt,
    );
  const selected: RankedMemoryEntry[] = [];
  const selectedByScope = createEmptyScopeCounts();
  let contextCharacters = 0;

  for (const candidate of ranked) {
    const scope = candidate.entry.scope;
    const nextCharacters =
      contextCharacters + candidate.entry.content.length + 3;

    if (
      selected.length >= maxEntries ||
      selectedByScope[scope] >= SCOPE_QUOTAS[scope] ||
      nextCharacters > maxCharacters
    ) {
      continue;
    }

    selected.push(candidate);
    selectedByScope[scope] += 1;
    contextCharacters = nextCharacters;
  }

  return {
    entries: selected.map((candidate) => candidate.entry),
    ranked: selected,
    diagnostics: {
      candidateCount: entries.length,
      selectedCount: selected.length,
      selectedByScope,
      contextCharacters,
      selectionSignals: Array.from(
        new Set(selected.flatMap((candidate) => candidate.reasons)),
      ),
    },
  };
};
