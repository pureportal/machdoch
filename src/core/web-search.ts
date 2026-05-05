import { hasConfiguredValue, loadWorkspaceEnv } from "./env.js";
import type { RuntimeConfig, WebSearchProvider } from "./types.js";

type ActiveWebSearchProvider = Exclude<WebSearchProvider, "none">;

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const SERPER_SEARCH_URL = "https://google.serper.dev/search";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface WebSearchResponse {
  provider: ActiveWebSearchProvider;
  query: string;
  summary?: string;
  results: WebSearchResult[];
}

const clampMaxResults = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }

  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.trunc(value)));
};

const coerceString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

const formatHttpError = async (response: Response): Promise<string> => {
  const detail = (await response.text()).trim();

  return detail.length > 0
    ? `${response.status} ${response.statusText}: ${detail}`
    : `${response.status} ${response.statusText}`;
};

const runPerplexitySearch = async (
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> => {
  const response = await fetch(PERPLEXITY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      max_tokens: 8_000,
      max_tokens_per_page: 1_024,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Perplexity web search request failed: ${await formatHttpError(response)}`,
    );
  }

  const payload = (await response.json()) as {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      snippet?: unknown;
      date?: unknown;
      last_updated?: unknown;
    }>;
  };

  return {
    provider: "perplexity",
    query,
    results: (payload.results ?? []).flatMap((result) => {
      const title = coerceString(result.title);
      const url = coerceString(result.url);
      const date =
        coerceString(result.date) ?? coerceString(result.last_updated);

      if (!title || !url) {
        return [];
      }

      return [
        {
          title,
          url,
          snippet: coerceString(result.snippet) ?? "No snippet was returned.",
          ...(date ? { date } : {}),
        },
      ];
    }),
  };
};

const runTavilySearch = async (
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> => {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "basic",
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Tavily web search request failed: ${await formatHttpError(response)}`,
    );
  }

  const payload = (await response.json()) as {
    answer?: unknown;
    results?: Array<{
      title?: unknown;
      url?: unknown;
      content?: unknown;
      published_date?: unknown;
    }>;
  };
  const summary = coerceString(payload.answer);

  return {
    provider: "tavily",
    query,
    ...(summary ? { summary } : {}),
    results: (payload.results ?? []).flatMap((result) => {
      const title = coerceString(result.title);
      const url = coerceString(result.url);
      const date = coerceString(result.published_date);

      if (!title || !url) {
        return [];
      }

      return [
        {
          title,
          url,
          snippet: coerceString(result.content) ?? "No snippet was returned.",
          ...(date ? { date } : {}),
        },
      ];
    }),
  };
};

const runSerperSearch = async (
  apiKey: string,
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> => {
  const response = await fetch(SERPER_SEARCH_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Serper web search request failed: ${await formatHttpError(response)}`,
    );
  }

  const payload = (await response.json()) as {
    answerBox?: {
      answer?: unknown;
      snippet?: unknown;
    };
    knowledgeGraph?: {
      description?: unknown;
    };
    organic?: Array<{
      title?: unknown;
      link?: unknown;
      snippet?: unknown;
      date?: unknown;
    }>;
  };
  const summary =
    coerceString(payload.answerBox?.answer) ??
    coerceString(payload.answerBox?.snippet) ??
    coerceString(payload.knowledgeGraph?.description);

  return {
    provider: "serper",
    query,
    ...(summary ? { summary } : {}),
    results: (payload.organic ?? []).flatMap((result) => {
      const title = coerceString(result.title);
      const url = coerceString(result.link);
      const date = coerceString(result.date);

      if (!title || !url) {
        return [];
      }

      return [
        {
          title,
          url,
          snippet: coerceString(result.snippet) ?? "No snippet was returned.",
          ...(date ? { date } : {}),
        },
      ];
    }),
  };
};

export const getConfiguredWebSearchProvider = (
  config: Pick<RuntimeConfig, "webSearch">,
): ActiveWebSearchProvider | undefined => {
  const { activeProvider, providerAvailability } = config.webSearch;

  if (activeProvider === "none") {
    return undefined;
  }

  return providerAvailability.some(
    (entry) => entry.provider === activeProvider && entry.configured,
  )
    ? activeProvider
    : undefined;
};

export const executeWebSearch = async (
  workspaceRoot: string,
  provider: ActiveWebSearchProvider,
  query: string,
  maxResults?: number,
): Promise<WebSearchResponse> => {
  const env = await loadWorkspaceEnv(workspaceRoot);
  const normalizedQuery = query.trim();
  const normalizedMaxResults = clampMaxResults(maxResults);

  if (normalizedQuery.length === 0) {
    throw new Error("Expected a non-empty web search query.");
  }

  switch (provider) {
    case "perplexity": {
      const apiKey = coerceString(env.PERPLEXITY_API_KEY);

      if (!apiKey || !hasConfiguredValue(apiKey)) {
        throw new Error(
          "Perplexity web search is not configured for this runtime.",
        );
      }

      return runPerplexitySearch(apiKey, normalizedQuery, normalizedMaxResults);
    }

    case "tavily": {
      const apiKey = coerceString(env.TAVILY_API_KEY);

      if (!apiKey || !hasConfiguredValue(apiKey)) {
        throw new Error(
          "Tavily web search is not configured for this runtime.",
        );
      }

      return runTavilySearch(apiKey, normalizedQuery, normalizedMaxResults);
    }

    case "serper": {
      const apiKey = coerceString(env.SERPER_API_KEY);

      if (!apiKey || !hasConfiguredValue(apiKey)) {
        throw new Error("Serper web search is not configured for this runtime.");
      }

      return runSerperSearch(apiKey, normalizedQuery, normalizedMaxResults);
    }
  }
};
