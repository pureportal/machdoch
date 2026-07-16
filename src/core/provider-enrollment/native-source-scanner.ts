import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type { CompiledInstructionBundle } from "./types.js";
import { sha256 } from "./digests.js";

export interface NativeInstructionFinding {
  path: string;
  digest: string;
  policy: "adopted" | "allowed";
  sourceId?: string;
}

const walkMarkdownFiles = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return await walkMarkdownFiles(path);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".md") ? [path] : [];
  }));
  return nested.flat();
};

const getCandidatePaths = async (
  provider: AgentCliProvider,
  workspaceRoot: string,
): Promise<string[]> => {
  switch (provider) {
    case "codex-cli":
      return [
        join(workspaceRoot, "AGENTS.override.md"),
        join(workspaceRoot, "AGENTS.md"),
      ];
    case "claude-cli":
      return [
        join(workspaceRoot, "CLAUDE.md"),
        join(workspaceRoot, "CLAUDE.local.md"),
        ...(await walkMarkdownFiles(join(workspaceRoot, ".claude", "rules"))),
      ];
    case "copilot-cli":
      return [
        join(workspaceRoot, "AGENTS.md"),
        join(workspaceRoot, ".github", "copilot-instructions.md"),
        ...(await walkMarkdownFiles(join(workspaceRoot, ".github", "instructions"))),
      ];
  }
};

const normalizedPathMatches = (sourcePath: string, candidatePath: string): boolean => {
  const source = sourcePath.replaceAll("\\", "/").toLowerCase();
  const candidate = candidatePath.replaceAll("\\", "/").toLowerCase();
  return candidate.endsWith(`/${source}`) || source === candidate || source.endsWith(`/${candidate}`);
};

export const scanNativeInstructionSources = async (
  provider: AgentCliProvider,
  workspaceRoot: string,
  bundle: CompiledInstructionBundle,
): Promise<NativeInstructionFinding[]> => {
  const findings: NativeInstructionFinding[] = [];
  for (const path of [...new Set(await getCandidatePaths(provider, workspaceRoot))].sort()) {
    const exists = await stat(path).then((metadata) => metadata.isFile(), () => false);
    if (!exists) continue;
    const content = await readFile(path, "utf8");
    const source = bundle.sources.find(
      (entry) => entry.sourcePath && normalizedPathMatches(entry.sourcePath, path),
    );
    findings.push({
      path,
      digest: sha256(content),
      policy: source ? "adopted" : "allowed",
      ...(source ? { sourceId: source.id } : {}),
    });
  }
  return findings;
};
