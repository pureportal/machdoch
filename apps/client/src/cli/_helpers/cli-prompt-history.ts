import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../../core/env.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../../core/_helpers/write-file-atomically.helper.js";

const historyPath = (): string =>
  join(dirname(getUserConfigPath()), "cli-prompt-history.json");

export const loadPromptHistory = async (): Promise<string[]> => {
  let raw: string;
  try {
    raw = await readFile(historyPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const history: unknown = JSON.parse(raw);
  if (
    !Array.isArray(history) ||
    !history.every((entry) => typeof entry === "string")
  )
    throw new Error(
      "Prompt history is invalid. Remove cli-prompt-history.json to reset it.",
    );
  return history.slice(0, 500);
};

export const savePromptHistory = async (text: string): Promise<void> => {
  if (!text.trim()) return;
  const path = historyPath();
  await withCooperativeFileLock(path, async () => {
    const history = await loadPromptHistory();
    await writeJsonAtomically(
      path,
      [text, ...history.filter((entry) => entry !== text)].slice(0, 500),
    );
  });
};
