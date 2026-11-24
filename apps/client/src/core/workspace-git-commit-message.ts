import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { loadRuntimeConfig } from "./config.js";
import { executeInternalTaskModelInference } from "./internal-task-model.js";

const execFileAsync = promisify(execFile);

const GENERATION_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SUBJECT_CHARS = 72;

const SYSTEM_PROMPT = [
  "You write one Git commit message for the staged changes you are given.",
  `Start with a subject line of at most ${MAX_SUBJECT_CHARS} characters in the imperative mood, without a trailing period.`,
  "Follow the style of the recent commit subjects, including prefixes or emoji they use consistently.",
  "Add a body after a blank line only when the change needs explanation; wrap it at 72 characters and describe why, not how.",
  "Return only the commit message, without quotes, code fences or commentary.",
].join("\n");

export interface StagedChanges {
  stat: string;
  diff: string;
  recentSubjects: string[];
}

export const truncateStagedDiff = (
  diff: string,
  limit = MAX_DIFF_CHARS,
): string => {
  if (diff.length <= limit) return diff;
  const cut = diff.lastIndexOf("\ndiff --git ", limit);
  const end = cut > 0 ? cut : limit;
  return `${diff.slice(0, end)}\n[${diff.length - end} more characters of diff omitted]`;
};

export const formatCommitMessagePrompt = ({
  stat,
  diff,
  recentSubjects,
}: StagedChanges): string =>
  [
    "Recent commit subjects:",
    recentSubjects.length > 0
      ? recentSubjects.map((subject) => `- ${subject}`).join("\n")
      : "(none)",
    "",
    "Staged files:",
    stat.trim(),
    "",
    "Staged diff:",
    truncateStagedDiff(diff),
  ].join("\n");

export const readCommitMessage = (text: string): string => {
  const unfenced = text
    .trim()
    .replace(/^```[^\n]*\n([\s\S]*?)\n```$/u, "$1")
    .trim();
  const unquoted =
    /^(["'`])[\s\S]*\1$/u.test(unfenced) && unfenced.length > 1
      ? unfenced.slice(1, -1).trim()
      : unfenced;
  const lines = unquoted.split(/\r?\n/u);
  const subject = (lines[0] ?? "").trim().replace(/\.$/u, "");
  if (!subject) throw new Error("The model returned an empty commit message.");
  const body = lines.slice(1).join("\n").trim();
  return body ? `${subject}\n\n${body}` : subject;
};

const git = async (repositoryRoot: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
};

const readStagedChanges = async (
  repositoryRoot: string,
): Promise<StagedChanges> => {
  const [stat, diff, log] = await Promise.all([
    git(repositoryRoot, ["diff", "--cached", "--stat", "--no-color"]),
    git(repositoryRoot, [
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
    ]),
    git(repositoryRoot, ["log", "-12", "--format=%s"]).catch(() => ""),
  ]);
  if (!diff.trim()) throw new Error("Stage changes to draft a message.");
  return {
    stat,
    diff,
    recentSubjects: log.split("\n").filter(Boolean),
  };
};

export const generateWorkspaceGitCommitMessage = async (
  workspaceRoot: string,
  repositoryRoot: string,
): Promise<{ message: string }> => {
  const repository = resolve(workspaceRoot, repositoryRoot);
  const [config, changes] = await Promise.all([
    loadRuntimeConfig(workspaceRoot),
    readStagedChanges(repository),
  ]);
  const turn = await executeInternalTaskModelInference(
    {
      ...config,
      internalTaskModel: { ...config.internalTaskModel, reasoning: "low" },
    },
    {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: formatCommitMessagePrompt(changes),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    },
  );
  return { message: readCommitMessage(turn.text) };
};
