import { open } from "node:fs/promises";

export interface RalphJsonlEntry {
  line: number;
  value: unknown;
}

export const queryRalphJsonl = async (
  path: string,
  options: {
    maxResults?: number;
    order?: "oldest" | "newest";
    matches?: (value: unknown) => boolean;
    validate?: (value: unknown) => string[];
  },
): Promise<{
  entries: RalphJsonlEntry[];
  totalCount: number;
  invalid: Array<{ line: number; error: string }>;
  validation: { valid: boolean; errors: string[] };
}> => {
  const handle = await open(path, "r");
  const entries: RalphJsonlEntry[] = [];
  const invalid: Array<{ line: number; error: string }> = [];
  const errors: string[] = [];
  const limit =
    typeof options.maxResults === "number" && options.maxResults >= 0
      ? options.maxResults
      : Number.POSITIVE_INFINITY;
  let line = 0;
  let totalCount = 0;
  try {
    for await (const text of handle.readLines()) {
      line += 1;
      if (!text.trim()) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        if (invalid.length < 100) {
          invalid.push({ line, error: String(error) });
        }
        continue;
      }
      totalCount += 1;
      const validationErrors = options.validate?.(value) ?? [];
      errors.push(
        ...validationErrors
          .slice(0, Math.max(0, 100 - errors.length))
          .map((error) => `line ${line}: ${error}`),
      );
      if ((options.matches && !options.matches(value)) || limit === 0) {
        continue;
      }
      if (options.order === "newest" || entries.length < limit) {
        entries.push({ line, value });
      }
      if (entries.length > limit) {
        entries.shift();
      }
    }
    if (options.order === "newest") {
      entries.reverse();
    }
    return {
      entries,
      totalCount,
      invalid,
      validation: { valid: errors.length === 0, errors },
    };
  } finally {
    await handle.close();
  }
};
