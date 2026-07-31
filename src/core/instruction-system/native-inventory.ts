import { homedir } from "node:os";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { ConfiguredModelProvider } from "../runtime-contract.generated.js";
import {
  MAX_DISCOVERED_LOCAL_FILES,
  MAX_INSTRUCTION_SOURCE_BYTES,
  compareCanonicalStrings,
  pathsEqualForHost,
  sha256,
} from "./normalization.js";
import { readOpenedFileExactly } from "../_helpers/read-opened-file-exactly.helper.js";
import { sameFileSnapshotIdentity } from "../_helpers/same-file-identity.helper.js";
import type {
  LocalInstructionRecord,
  NativeInstructionRecord,
} from "./types.js";
import { InstructionSystemError } from "./types.js";

interface NativeCandidate {
  path: string;
  location: "workspace" | "user";
  convention: string;
  canonical?: boolean;
  suppressible?: boolean;
  maxBytes?: number;
}

interface NativeDiscoveryBatch {
  candidates: NativeCandidate[];
  diagnostics: NativeInstructionRecord[];
}

const IGNORED_NATIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".machdoch",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "target",
]);
const MAX_NATIVE_DISCOVERY_DIRECTORIES = 50_000;
const MAX_NATIVE_CONFIG_BYTES = 1024 * 1024;
const MAX_CLAUDE_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_COPILOT_INTERNAL_STATE_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_ANCESTOR_DEPTH = 128;

const sameFileIdentity = (
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  before.isFile() === after.isFile() &&
  before.isSymbolicLink() === after.isSymbolicLink() &&
  sameFileSnapshotIdentity(before, after);

const sameDirectoryIdentity = (
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  before.isDirectory() &&
  after.isDirectory() &&
  !before.isSymbolicLink() &&
  !after.isSymbolicLink() &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs;

const readStableNativeDirectory = async (
  path: string,
  beforePath: Awaited<ReturnType<typeof lstat>>,
) => {
  const canonicalPath = await realpath(path);
  const canonicalBefore = await lstat(canonicalPath);
  if (
    !sameDirectoryIdentity(beforePath, canonicalBefore) ||
    !sameDirectoryIdentity(beforePath, await lstat(path))
  ) {
    throw new Error("directory identity changed while it was resolved");
  }
  const entries = await readdir(canonicalPath, { withFileTypes: true });
  const [afterPath, canonicalAfter] = await Promise.all([
    lstat(path),
    lstat(canonicalPath),
  ]);
  if (
    !sameDirectoryIdentity(beforePath, afterPath) ||
    !sameDirectoryIdentity(beforePath, canonicalAfter)
  ) {
    throw new Error("directory identity changed while it was read");
  }
  return { canonicalPath, entries };
};

const readStableNativeFile = async (
  path: string,
  beforePath: Awaited<ReturnType<typeof lstat>>,
): Promise<Buffer> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const beforeOpened = await handle.stat();
    if (!sameFileIdentity(beforePath, beforeOpened)) {
      throw new Error("file identity changed before the safe open completed");
    }
    const bytes = await readOpenedFileExactly(handle, beforeOpened.size);
    const [afterOpened, afterPath] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      !sameFileIdentity(beforeOpened, afterOpened) ||
      !sameFileIdentity(beforeOpened, afterPath)
    ) {
      throw new Error("file identity changed while it was read");
    }
    return bytes;
  } finally {
    await handle?.close();
  }
};

const workspaceCandidates = (root: string): NativeCandidate[] => [
  {
    path: join(root, "AGENTS.override.md"),
    location: "workspace",
    convention: "codex-project-agents-override",
  },
  {
    path: join(root, ".codex", "config.toml"),
    location: "workspace",
    convention: "codex-project-configuration",
  },
  {
    path: join(root, "CLAUDE.md"),
    location: "workspace",
    convention: "claude-project-memory",
  },
  {
    path: join(root, "CLAUDE.local.md"),
    location: "workspace",
    convention: "claude-project-memory",
  },
  {
    path: join(root, ".claude", "CLAUDE.md"),
    location: "workspace",
    convention: "claude-project-memory",
  },
  {
    path: join(root, ".claude", "settings.json"),
    location: "workspace",
    convention: "claude-project-settings",
    maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
  },
  {
    path: join(root, ".claude", "settings.local.json"),
    location: "workspace",
    convention: "claude-project-settings",
    maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
  },
  {
    path: join(root, "GEMINI.md"),
    location: "workspace",
    convention: "gemini-context-file",
  },
  {
    path: join(root, ".github", "copilot-instructions.md"),
    location: "workspace",
    convention: "copilot-repository-instructions",
    suppressible: true,
  },
  {
    path: join(root, ".github", "copilot", "settings.json"),
    location: "workspace",
    convention: "copilot-repository-settings",
  },
  {
    path: join(root, ".github", "copilot", "settings.local.json"),
    location: "workspace",
    convention: "copilot-repository-settings",
  },
];

const ancestorDirectories = (workspaceRoot: string): string[] => {
  const directories: string[] = [];
  let directory = resolve(workspaceRoot);
  for (let depth = 0; depth < MAX_NATIVE_ANCESTOR_DEPTH; depth += 1) {
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) return directories;
    directory = parent;
  }
  throw new InstructionSystemError(
    "NATIVE_INSTRUCTION_ANCESTOR_LIMIT",
    `Native instruction inventory exceeded ${MAX_NATIVE_ANCESTOR_DEPTH} ancestor directories.`,
  );
};

const findGitRoot = async (
  workspaceRoot: string,
  providerId: "codex-cli" | "claude-cli" | "copilot-cli",
): Promise<{
  root?: string;
  diagnostics: NativeInstructionRecord[];
}> => {
  const diagnostics: NativeInstructionRecord[] = [];
  for (const directory of ancestorDirectories(workspaceRoot)) {
    const marker = join(directory, ".git");
    try {
      const metadata = await lstat(marker);
      if (
        metadata.isDirectory() ||
        (metadata.isFile() && !metadata.isSymbolicLink())
      ) {
        return { root: directory, diagnostics };
      }
      diagnostics.push({
        path: marker,
        location: "workspace",
        convention: `${providerId}-project-root`,
        status: "unknown",
        note: "A linked or non-regular Git marker prevented exact provider project-root detection.",
      });
      return { diagnostics };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      diagnostics.push({
        path: marker,
        location: "workspace",
        convention: `${providerId}-project-root`,
        status: "unknown",
        note: "The Git marker could not be inspected, so provider project-root discovery is indeterminate.",
      });
      return { diagnostics };
    }
  }
  return { diagnostics };
};

const directoryChain = (root: string, workspaceRoot: string): string[] => {
  const ancestors = ancestorDirectories(workspaceRoot);
  const rootIndex = ancestors.findIndex((directory) =>
    pathsEqualForHost(directory, root),
  );
  return rootIndex < 0
    ? [resolve(workspaceRoot)]
    : ancestors.slice(0, rootIndex + 1).reverse();
};

const userCandidates = (
  providerId: ConfiguredModelProvider,
  surface: "api" | "cli",
): NativeCandidate[] => {
  if (surface !== "cli") return [];
  if (providerId === "codex-cli") {
    const codexHome =
      process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    return [
      {
        path: join(codexHome, "AGENTS.override.md"),
        location: "user",
        convention: "codex-user-agents-override",
        suppressible: true,
      },
      {
        path: join(codexHome, "AGENTS.md"),
        location: "user",
        convention: "codex-user-agents",
        suppressible: true,
      },
      {
        path: join(codexHome, "config.toml"),
        location: "user",
        convention: "codex-user-configuration",
        suppressible: true,
        maxBytes: MAX_NATIVE_CONFIG_BYTES,
      },
    ];
  }
  if (providerId === "claude-cli") {
    const claudeHome =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return [
      {
        path: join(claudeHome, "CLAUDE.md"),
        location: "user",
        convention: "claude-user-memory",
      },
      {
        path: join(claudeHome, "settings.json"),
        location: "user",
        convention: "claude-user-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      },
    ];
  }
  if (providerId === "copilot-cli") {
    const copilotHome =
      process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
    return [
      {
        path: join(copilotHome, "copilot-instructions.md"),
        location: "user",
        convention: "copilot-user-instructions",
        suppressible: true,
      },
      {
        path: join(copilotHome, "config.json"),
        location: "user",
        convention: "copilot-user-internal-state",
        maxBytes: MAX_COPILOT_INTERNAL_STATE_BYTES,
      },
    ];
  }
  return [];
};

const parseCodexFallbackNames = (content: string): string[] => {
  const assignment =
    /(?:^|\n)\s*project_doc_fallback_filenames\s*=\s*\[(?<value>[\s\S]*?)\]/mu.exec(
      content,
    )?.groups?.value;
  if (assignment === undefined) return [];
  const names: string[] = [];
  for (const match of assignment.matchAll(/["'](?<name>[^"'\\\r\n]+)["']/gu)) {
    const name = match.groups?.name?.trim();
    if (
      name &&
      name !== "." &&
      basename(name) === name &&
      !name.includes("/") &&
      !name.includes("\\")
    ) {
      names.push(name);
    }
  }
  return [...new Set(names)].sort(compareCanonicalStrings);
};

const codexFallbackCandidates = async (input: {
  workspaceRoot: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  projectDirectories?: readonly string[];
}): Promise<{
  candidates: NativeCandidate[];
  diagnostics: NativeInstructionRecord[];
}> => {
  const configPaths = [
    ...new Set(
      (input.projectDirectories ?? [input.workspaceRoot]).map((directory) =>
        join(directory, ".codex", "config.toml"),
      ),
    ),
  ];
  const names = new Set<string>();
  const diagnostics: NativeInstructionRecord[] = [];
  for (const configPath of configPaths) {
    try {
      const before = await lstat(configPath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > MAX_NATIVE_CONFIG_BYTES
      ) {
        throw new Error("not a bounded regular configuration file");
      }
      const bytes = await readStableNativeFile(configPath, before);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      for (const name of parseCodexFallbackNames(content)) names.add(name);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      diagnostics.push({
        path: configPath,
        location: pathsEqualForHost(
          resolve(configPath),
          resolve(join(input.workspaceRoot, ".codex", "config.toml")),
        )
          ? "workspace"
          : "user",
        convention: "codex-fallback-configuration",
        status: "unknown",
        note: "Configured Codex fallback instruction filenames could not be inventoried from this documented configuration path.",
      });
    }
  }
  return {
    candidates: (input.projectDirectories ?? [input.workspaceRoot]).flatMap(
      (directory) =>
        [...names].map((name) => ({
          path: join(directory, name),
          location: "workspace" as const,
          convention: "codex-project-fallback",
        })),
    ),
    diagnostics,
  };
};

const providerUsesConvention = (
  provider: ConfiguredModelProvider,
  convention: string,
): boolean => {
  if (provider === "codex-cli") return convention.includes("codex");
  if (provider === "claude-cli") return convention.includes("claude");
  if (provider === "copilot-cli") {
    return (
      convention.includes("copilot") ||
      convention === "agents-md" ||
      convention === "claude-project-memory" ||
      convention === "claude-custom-agents" ||
      convention === "gemini-context-file"
    );
  }
  return false;
};

const copilotSuppressesConvention = (convention: string): boolean =>
  convention === "agents-md" ||
  convention === "claude-project-memory" ||
  convention === "gemini-context-file" ||
  convention === "copilot-repository-instructions" ||
  convention === "copilot-path-instructions" ||
  convention === "copilot-user-instructions" ||
  convention === "copilot-user-agents" ||
  convention === "claude-or-copilot-nested-instructions";

const codexSuppressesConvention = (convention: string): boolean =>
  convention === "codex-project-agents-override" ||
  convention === "codex-project-agents" ||
  convention === "codex-project-fallback" ||
  convention === "codex-project-configuration" ||
  convention === "codex-fallback-configuration" ||
  convention === "codex-user-agents-override" ||
  convention === "codex-user-agents" ||
  convention === "codex-user-configuration";

const classifyInventoryDiagnostic = (
  record: NativeInstructionRecord,
  providerId: ConfiguredModelProvider,
  surface: "api" | "cli",
): NativeInstructionRecord => {
  const active =
    surface === "cli" && providerUsesConvention(providerId, record.convention);
  if (!active) {
    return {
      ...record,
      status: "inactive",
      note:
        record.note === undefined
          ? "This native inventory diagnostic is inactive for the selected surface."
          : `${record.note} It is inactive for the selected surface.`,
    };
  }
  if (
    (providerId === "codex-cli" &&
      codexSuppressesConvention(record.convention)) ||
    (providerId === "copilot-cli" &&
      copilotSuppressesConvention(record.convention))
  ) {
    return {
      ...record,
      status: "suppressed",
      note: "The run-scoped Copilot adapter suppresses or isolates this documented native source.",
    };
  }
  return record;
};

const inspectCandidate = async (
  candidate: NativeCandidate,
  providerId: ConfiguredModelProvider,
  surface: "api" | "cli",
): Promise<NativeInstructionRecord | undefined> => {
  const active =
    surface === "cli" &&
    providerUsesConvention(providerId, candidate.convention);
  const suppressed =
    active &&
    (candidate.suppressible === true ||
      (providerId === "codex-cli" &&
        codexSuppressesConvention(candidate.convention)) ||
      (providerId === "copilot-cli" &&
        copilotSuppressesConvention(candidate.convention)));
  const unreadableStatus: NativeInstructionRecord["status"] = suppressed
    ? "suppressed"
    : active
      ? "unreadable"
      : "inactive";
  let metadata;
  try {
    metadata = await lstat(candidate.path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status: unreadableStatus,
      note: suppressed
        ? "The run-scoped adapter suppresses this documented native source; its bytes do not need to be read."
        : active
          ? "The active native instruction path could not be inspected."
          : "The inactive native instruction path could not be inspected.",
    };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status: unreadableStatus,
      note: suppressed
        ? "The run-scoped adapter suppresses this documented native path."
        : "Native instructions must be a regular file, not a link.",
    };
  }
  const maxBytes = candidate.maxBytes ?? MAX_INSTRUCTION_SOURCE_BYTES;
  if (metadata.size > maxBytes) {
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status: unreadableStatus,
      byteLength: metadata.size,
      note: `The file exceeds ${maxBytes} bytes.`,
    };
  }
  if (suppressed) {
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status: "suppressed",
      byteLength: metadata.size,
      note: "The run-scoped adapter suppresses this documented native source; its bytes were not read.",
    };
  }
  try {
    const body = await readStableNativeFile(candidate.path, metadata);
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status:
        surface === "api"
          ? "inactive"
          : active
            ? suppressed
              ? "suppressed"
              : "native-extra"
            : "inactive",
      digest: sha256(body),
      byteLength: body.byteLength,
      ...(active
        ? {
            note: suppressed
              ? "The run-scoped adapter suppresses this documented native source."
              : "This documented native source may remain active in addition to the canonical envelope.",
          }
        : {}),
    };
  } catch {
    return {
      path: candidate.path,
      location: candidate.location,
      convention: candidate.convention,
      status: unreadableStatus,
      note: suppressed
        ? "The run-scoped adapter suppresses this documented native source; its bytes do not need to be read."
        : active
          ? "The active native instruction file could not be read."
          : "The inactive native instruction file could not be read.",
    };
  }
};

const discoverCopilotPathInstructions = async (
  workspaceRoot: string,
): Promise<NativeDiscoveryBatch> => {
  const directory = join(workspaceRoot, ".github", "instructions");
  return discoverMarkdownRules(
    directory,
    "copilot-path-instructions",
    true,
    "workspace",
    (name) => name.toLocaleLowerCase("en-US").endsWith(".instructions.md"),
  );
};

const discoverMarkdownRules = async (
  root: string,
  convention: string,
  suppressible = false,
  location: NativeCandidate["location"] = "workspace",
  matches: (name: string) => boolean = (name) =>
    name.toLocaleLowerCase("en-US").endsWith(".md"),
  maxBytes?: number,
): Promise<NativeDiscoveryBatch> => {
  const candidates: NativeCandidate[] = [];
  const diagnostics: NativeInstructionRecord[] = [];
  let visited = 0;
  const visit = async (directory: string): Promise<void> => {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      diagnostics.push({
        path: directory,
        location,
        convention,
        status: "unreadable",
        note: "The native rule directory could not be inspected.",
      });
      return;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      diagnostics.push({
        path: directory,
        location,
        convention,
        status: "unreadable",
        note: "The native rule directory is not a regular directory or is a link.",
      });
      return;
    }
    visited += 1;
    if (visited > MAX_NATIVE_DISCOVERY_DIRECTORIES) {
      throw new InstructionSystemError(
        "NATIVE_INSTRUCTION_DIRECTORY_LIMIT",
        `Native instruction inventory exceeded ${MAX_NATIVE_DISCOVERY_DIRECTORIES} rule directories under ${root}.`,
      );
    }
    let stableDirectory;
    try {
      stableDirectory = await readStableNativeDirectory(directory, metadata);
    } catch {
      diagnostics.push({
        path: directory,
        location,
        convention,
        status: "unreadable",
        note: "The native rule directory changed or could not be read safely.",
      });
      return;
    }
    directory = stableDirectory.canonicalPath;
    const entries = stableDirectory.entries;
    entries.sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (matches(entry.name)) {
          candidates.push({
            path,
            location,
            convention,
            suppressible,
            ...(maxBytes === undefined ? {} : { maxBytes }),
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (
          !IGNORED_NATIVE_DIRECTORY_NAMES.has(
            entry.name.toLocaleLowerCase("en-US"),
          )
        ) {
          await visit(path);
        }
      } else if (matches(entry.name)) {
        candidates.push({
          path,
          location,
          convention,
          suppressible,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
      }
      if (candidates.length > MAX_DISCOVERED_LOCAL_FILES) {
        throw new InstructionSystemError(
          "NATIVE_INSTRUCTION_FILE_LIMIT",
          `Native instruction inventory exceeded ${MAX_DISCOVERED_LOCAL_FILES} rule files under ${root}.`,
        );
      }
    }
  };
  await visit(root);
  return { candidates, diagnostics };
};

const discoverNestedAgentInstructionFiles = async (
  workspaceRoot: string,
): Promise<NativeDiscoveryBatch> => {
  const candidates: NativeCandidate[] = [];
  const diagnostics: NativeInstructionRecord[] = [];
  const canonicalWorkspaceRoot = await realpath(workspaceRoot).catch(() =>
    resolve(workspaceRoot),
  );
  let directories = 0;
  const visit = async (directory: string): Promise<void> => {
    directories += 1;
    if (directories > MAX_NATIVE_DISCOVERY_DIRECTORIES) {
      throw new InstructionSystemError(
        "NATIVE_INSTRUCTION_DIRECTORY_LIMIT",
        `Native instruction inventory exceeded ${MAX_NATIVE_DISCOVERY_DIRECTORIES} workspace directories while looking for nested provider instructions.`,
      );
    }
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch {
      diagnostics.push({
        path: directory,
        location: "workspace",
        convention: "claude-or-copilot-nested-instructions",
        status: "unreadable",
        note: "A workspace directory could not be inspected during native instruction inventory.",
      });
      return;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      diagnostics.push({
        path: directory,
        location: "workspace",
        convention: "claude-or-copilot-nested-instructions",
        status: "unreadable",
        note: "A workspace directory was linked or not a directory during native instruction inventory.",
      });
      return;
    }
    let stableDirectory;
    try {
      stableDirectory = await readStableNativeDirectory(directory, metadata);
    } catch {
      diagnostics.push({
        path: directory,
        location: "workspace",
        convention: "claude-or-copilot-nested-instructions",
        status: "unreadable",
        note: "A workspace directory changed or could not be read safely during native instruction inventory.",
      });
      return;
    }
    directory = stableDirectory.canonicalPath;
    const entries = stableDirectory.entries;
    entries.sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          !IGNORED_NATIVE_DIRECTORY_NAMES.has(
            entry.name.toLocaleLowerCase("en-US"),
          )
        ) {
          await visit(path);
        }
        continue;
      }
      const upperName = entry.name.toLocaleUpperCase("en-US");
      const workspaceRelative = relative(
        canonicalWorkspaceRoot,
        path,
      ).replaceAll("\\", "/");
      if (upperName === "CLAUDE.MD" || upperName === "CLAUDE.LOCAL.MD") {
        candidates.push({
          path,
          location: "workspace",
          convention: "claude-project-memory",
        });
      } else if (upperName === "GEMINI.MD") {
        candidates.push({
          path,
          location: "workspace",
          convention: "gemini-context-file",
        });
      } else if (
        /(?:^|\/)\.github\/copilot-instructions\.md$/iu.test(workspaceRelative)
      ) {
        candidates.push({
          path,
          location: "workspace",
          convention: "copilot-repository-instructions",
          suppressible: true,
        });
      } else if (
        /(?:^|\/)\.github\/instructions\/.+\.instructions\.md$/iu.test(
          workspaceRelative,
        )
      ) {
        candidates.push({
          path,
          location: "workspace",
          convention: "copilot-path-instructions",
          suppressible: true,
        });
      }
      if (candidates.length > MAX_DISCOVERED_LOCAL_FILES) {
        throw new InstructionSystemError(
          "NATIVE_INSTRUCTION_FILE_LIMIT",
          `Native instruction inventory exceeded ${MAX_DISCOVERED_LOCAL_FILES} nested provider instruction files.`,
        );
      }
    }
  };
  await visit(workspaceRoot);
  return { candidates, diagnostics };
};

const discoverProviderAncestorInstructions = async (input: {
  workspaceRoot: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  gitRoot?: string;
}): Promise<NativeDiscoveryBatch> => {
  if (input.surface !== "cli") {
    return { candidates: [], diagnostics: [] };
  }

  const candidates: NativeCandidate[] = [];
  const diagnostics: NativeInstructionRecord[] = [];
  const gitChain = directoryChain(
    input.gitRoot ?? input.workspaceRoot,
    input.workspaceRoot,
  );

  if (input.providerId === "codex-cli") {
    for (const directory of gitChain) {
      candidates.push(
        {
          path: join(directory, "AGENTS.override.md"),
          location: "workspace",
          convention: "codex-project-agents-override",
        },
        {
          path: join(directory, "AGENTS.md"),
          location: "workspace",
          convention: "codex-project-agents",
        },
        {
          path: join(directory, ".codex", "config.toml"),
          location: "workspace",
          convention: "codex-project-configuration",
        },
      );
    }
  } else if (input.providerId === "claude-cli") {
    for (const directory of ancestorDirectories(input.workspaceRoot)) {
      candidates.push(
        {
          path: join(directory, "CLAUDE.md"),
          location: "workspace",
          convention: "claude-project-memory",
        },
        {
          path: join(directory, "CLAUDE.local.md"),
          location: "workspace",
          convention: "claude-project-memory",
        },
        {
          path: join(directory, ".claude", "CLAUDE.md"),
          location: "workspace",
          convention: "claude-project-memory",
        },
      );
    }
    const managedPolicyPath =
      process.platform === "win32"
        ? join(
            process.env.ProgramFiles?.trim() || "C:\\Program Files",
            "ClaudeCode",
            "CLAUDE.md",
          )
        : process.platform === "darwin"
          ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
          : "/etc/claude-code/CLAUDE.md";
    const managedConfigurationRoot = dirname(managedPolicyPath);
    candidates.push(
      {
        path: managedPolicyPath,
        location: "user",
        convention: "claude-managed-policy",
      },
      {
        path: join(managedConfigurationRoot, "managed-settings.json"),
        location: "user",
        convention: "claude-managed-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      },
      {
        path: join(managedConfigurationRoot, "managed-mcp.json"),
        location: "user",
        convention: "claude-managed-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      },
    );
    const repositoryRoot = gitChain[0] ?? input.workspaceRoot;
    candidates.push(
      {
        path: join(repositoryRoot, ".claude", "settings.json"),
        location: "workspace",
        convention: "claude-project-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      },
      {
        path: join(repositoryRoot, ".claude", "settings.local.json"),
        location: "workspace",
        convention: "claude-project-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      },
    );
    if (!pathsEqualForHost(repositoryRoot, input.workspaceRoot)) {
      candidates.push({
        path: join(input.workspaceRoot, ".claude", "settings.local.json"),
        location: "workspace",
        convention: "claude-project-settings",
        maxBytes: MAX_CLAUDE_SETTINGS_BYTES,
      });
    }
  } else if (input.providerId === "copilot-cli") {
    for (const directory of gitChain) {
      candidates.push(
        {
          path: join(directory, "AGENTS.md"),
          location: "workspace",
          convention: "agents-md",
          suppressible: true,
        },
        {
          path: join(directory, "CLAUDE.md"),
          location: "workspace",
          convention: "claude-project-memory",
          suppressible: true,
        },
        {
          path: join(directory, "GEMINI.md"),
          location: "workspace",
          convention: "gemini-context-file",
          suppressible: true,
        },
        {
          path: join(directory, ".github", "copilot-instructions.md"),
          location: "workspace",
          convention: "copilot-repository-instructions",
          suppressible: true,
        },
      );
    }
    const repositoryRoot = gitChain[0] ?? input.workspaceRoot;
    candidates.push(
      {
        path: join(repositoryRoot, ".github", "copilot", "settings.json"),
        location: "workspace",
        convention: "copilot-repository-settings",
      },
      {
        path: join(repositoryRoot, ".github", "copilot", "settings.local.json"),
        location: "workspace",
        convention: "copilot-repository-settings",
      },
      {
        path: join(repositoryRoot, ".claude", "settings.json"),
        location: "workspace",
        convention: "copilot-repository-settings",
      },
      {
        path: join(repositoryRoot, ".claude", "settings.local.json"),
        location: "workspace",
        convention: "copilot-repository-settings",
      },
    );
  }

  const recursiveBatches: NativeDiscoveryBatch[] = [];
  if (input.providerId === "claude-cli") {
    const managedPolicyPath =
      process.platform === "win32"
        ? join(
            process.env.ProgramFiles?.trim() || "C:\\Program Files",
            "ClaudeCode",
            "CLAUDE.md",
          )
        : process.platform === "darwin"
          ? "/Library/Application Support/ClaudeCode/CLAUDE.md"
          : "/etc/claude-code/CLAUDE.md";
    recursiveBatches.push(
      await discoverMarkdownRules(
        join(dirname(managedPolicyPath), "managed-settings.d"),
        "claude-managed-settings",
        false,
        "user",
        (name) => name.toLocaleLowerCase("en-US").endsWith(".json"),
        MAX_CLAUDE_SETTINGS_BYTES,
      ),
    );
    for (const directory of gitChain) {
      if (!pathsEqualForHost(directory, input.workspaceRoot)) {
        recursiveBatches.push(
          await discoverMarkdownRules(
            join(directory, ".claude", "rules"),
            "claude-project-rules",
          ),
        );
      }
      recursiveBatches.push(
        await discoverMarkdownRules(
          join(directory, ".claude", "agents"),
          "claude-custom-agents",
        ),
      );
    }
  } else if (input.providerId === "copilot-cli") {
    for (const directory of gitChain) {
      if (!pathsEqualForHost(directory, input.workspaceRoot)) {
        recursiveBatches.push(
          await discoverMarkdownRules(
            join(directory, ".github", "instructions"),
            "copilot-path-instructions",
            true,
            "workspace",
            (name) =>
              name.toLocaleLowerCase("en-US").endsWith(".instructions.md"),
          ),
          await discoverMarkdownRules(
            join(directory, ".github", "agents"),
            "copilot-custom-agents",
          ),
        );
      }
      recursiveBatches.push(
        await discoverMarkdownRules(
          join(directory, ".claude", "agents"),
          "claude-custom-agents",
        ),
      );
    }
  }
  for (const batch of recursiveBatches) {
    candidates.push(...batch.candidates);
    diagnostics.push(...batch.diagnostics);
  }
  return { candidates, diagnostics };
};

const nativeStatusRank: Record<NativeInstructionRecord["status"], number> = {
  inactive: 0,
  unknown: 1,
  canonical: 2,
  suppressed: 3,
  "native-extra": 4,
  unreadable: 5,
};

const mergeNativeRecords = (
  records: readonly NativeInstructionRecord[],
): NativeInstructionRecord[] => {
  const merged = new Map<string, NativeInstructionRecord>();
  for (const record of records) {
    const key =
      process.platform === "win32"
        ? resolve(record.path).toLocaleLowerCase("en-US")
        : resolve(record.path);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...record,
        recognizingConventions: [
          ...new Set([
            record.convention,
            ...(record.recognizingConventions ?? []),
          ]),
        ],
      });
      continue;
    }
    const recognizingConventions = [
      ...new Set([
        ...(existing.recognizingConventions ?? [existing.convention]),
        record.convention,
        ...(record.recognizingConventions ?? []),
      ]),
    ].sort(compareCanonicalStrings);
    const preferred =
      nativeStatusRank[record.status] > nativeStatusRank[existing.status]
        ? record
        : existing;
    const notes = [...new Set([existing.note, record.note].filter(Boolean))];
    merged.set(key, {
      ...preferred,
      recognizingConventions,
      ...(preferred.digest === undefined && existing.digest !== undefined
        ? { digest: existing.digest }
        : {}),
      ...(preferred.byteLength === undefined &&
      existing.byteLength !== undefined
        ? { byteLength: existing.byteLength }
        : {}),
      ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
    });
  }
  return [...merged.values()].sort((left, right) =>
    compareCanonicalStrings(
      `${left.location}:${left.path}`,
      `${right.location}:${right.path}`,
    ),
  );
};

const createPublicNativePath = (
  record: NativeInstructionRecord,
  workspaceRoots: readonly string[],
): string => {
  if (record.location === "user") {
    return [
      "provider-user:",
      record.convention,
      sha256(resolve(record.path)).slice(0, 12),
      basename(record.path),
    ].join("/");
  }
  for (const workspaceRoot of workspaceRoots) {
    const workspaceRelative = relative(
      resolve(workspaceRoot),
      resolve(record.path),
    );
    if (
      workspaceRelative === "" ||
      (!workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative))
    ) {
      return (workspaceRelative || ".").replaceAll("\\", "/");
    }
  }
  return [
    "workspace-external:",
    sha256(resolve(record.path)).slice(0, 12),
    basename(record.path),
  ].join("/");
};

export const inventoryNativeInstructions = async (input: {
  workspaceRoot: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  locals: readonly LocalInstructionRecord[];
}): Promise<NativeInstructionRecord[]> => {
  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot).catch(() =>
    resolve(input.workspaceRoot),
  );
  const gitRootDiscovery =
    input.surface === "cli" &&
    (input.providerId === "codex-cli" ||
      input.providerId === "claude-cli" ||
      input.providerId === "copilot-cli")
      ? await findGitRoot(input.workspaceRoot, input.providerId)
      : { diagnostics: [] };
  const providerProjectDirectories = directoryChain(
    gitRootDiscovery.root ?? input.workspaceRoot,
    input.workspaceRoot,
  );
  const codexFallbacks = await codexFallbackCandidates({
    ...input,
    projectDirectories:
      input.surface === "cli" && input.providerId === "codex-cli"
        ? providerProjectDirectories
        : [input.workspaceRoot],
  });
  const copilotPathInstructions = await discoverCopilotPathInstructions(
    input.workspaceRoot,
  );
  const claudeProjectRules = await discoverMarkdownRules(
    join(input.workspaceRoot, ".claude", "rules"),
    "claude-project-rules",
  );
  const copilotCustomAgents = await discoverMarkdownRules(
    join(input.workspaceRoot, ".github", "agents"),
    "copilot-custom-agents",
  );
  const nestedAgentInstructions =
    input.surface === "cli" &&
    (input.providerId === "claude-cli" || input.providerId === "copilot-cli")
      ? await discoverNestedAgentInstructionFiles(input.workspaceRoot)
      : { candidates: [], diagnostics: [] };
  const providerAncestorInstructions =
    await discoverProviderAncestorInstructions({
      ...input,
      ...(gitRootDiscovery.root === undefined
        ? {}
        : { gitRoot: gitRootDiscovery.root }),
    });
  const copilotUserRules =
    input.surface === "cli" && input.providerId === "copilot-cli"
      ? await discoverMarkdownRules(
          join(
            process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot"),
            "instructions",
          ),
          "copilot-user-instructions",
          true,
          "user",
          (name) =>
            name.toLocaleLowerCase("en-US").endsWith(".instructions.md"),
        )
      : { candidates: [], diagnostics: [] };
  const copilotUserAgents =
    input.surface === "cli" && input.providerId === "copilot-cli"
      ? await discoverMarkdownRules(
          join(
            process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot"),
            "agents",
          ),
          "copilot-user-agents",
          true,
          "user",
        )
      : { candidates: [], diagnostics: [] };
  const claudeUserRules =
    input.surface === "cli" && input.providerId === "claude-cli"
      ? await discoverMarkdownRules(
          join(
            process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
            "rules",
          ),
          "claude-user-rules",
          false,
          "user",
        )
      : { candidates: [], diagnostics: [] };
  const claudeUserAgents =
    input.surface === "cli" && input.providerId === "claude-cli"
      ? await discoverMarkdownRules(
          join(
            process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
            "agents",
          ),
          "claude-custom-agents",
          false,
          "user",
        )
      : { candidates: [], diagnostics: [] };
  const canonicalLocals: NativeInstructionRecord[] = input.locals.map(
    (local) => ({
      path: join(input.workspaceRoot, local.relativePath),
      location: "workspace",
      convention: "agents-md",
      status: "canonical",
      digest: local.digest,
      byteLength: local.byteLength,
      note: "Loaded by Machdoch as a canonical project-local instruction.",
    }),
  );
  const canonicalNativeDuplicates: NativeInstructionRecord[] =
    input.surface === "cli" && input.providerId === "codex-cli"
      ? input.locals
          .filter((local) => local.relativePath === "AGENTS.md")
          .map((local) => ({
            path: join(input.workspaceRoot, local.relativePath),
            location: "workspace",
            convention: "codex-project-agents",
            status: "suppressed",
            digest: local.digest,
            byteLength: local.byteLength,
            note: "This canonical AGENTS.md is also recognized by Codex, but the run-scoped adapter disables project instruction discovery so it is delivered only through Machdoch's developer instructions.",
          }))
      : input.surface === "cli" && input.providerId === "copilot-cli"
        ? input.locals.map((local) => ({
            path: join(input.workspaceRoot, local.relativePath),
            location: "workspace",
            convention: "copilot-agent-instructions",
            status: "suppressed",
            digest: local.digest,
            byteLength: local.byteLength,
            note: "This canonical AGENTS.md is also recognized by Copilot CLI, and --no-custom-instructions suppresses that native copy.",
          }))
        : [];
  const candidates = [
    ...workspaceCandidates(input.workspaceRoot),
    ...codexFallbacks.candidates,
    ...copilotPathInstructions.candidates,
    ...claudeProjectRules.candidates,
    ...copilotCustomAgents.candidates,
    ...nestedAgentInstructions.candidates,
    ...providerAncestorInstructions.candidates,
    ...copilotUserRules.candidates,
    ...copilotUserAgents.candidates,
    ...claudeUserRules.candidates,
    ...claudeUserAgents.candidates,
    ...userCandidates(input.providerId, input.surface),
  ];
  if (candidates.length > MAX_DISCOVERED_LOCAL_FILES) {
    throw new InstructionSystemError(
      "NATIVE_INSTRUCTION_FILE_LIMIT",
      `Native instruction inventory exceeded ${MAX_DISCOVERED_LOCAL_FILES} provider-native candidates.`,
    );
  }
  const inspected = (
    await Promise.all(
      candidates.map((candidate) =>
        inspectCandidate(candidate, input.providerId, input.surface),
      ),
    )
  ).filter((record): record is NativeInstructionRecord => record !== undefined);
  return mergeNativeRecords([
    ...canonicalLocals,
    ...canonicalNativeDuplicates,
    ...[
      ...gitRootDiscovery.diagnostics,
      ...codexFallbacks.diagnostics,
      ...copilotPathInstructions.diagnostics,
      ...claudeProjectRules.diagnostics,
      ...copilotCustomAgents.diagnostics,
      ...nestedAgentInstructions.diagnostics,
      ...providerAncestorInstructions.diagnostics,
      ...copilotUserRules.diagnostics,
      ...copilotUserAgents.diagnostics,
      ...claudeUserRules.diagnostics,
      ...claudeUserAgents.diagnostics,
    ].map((record) =>
      classifyInventoryDiagnostic(record, input.providerId, input.surface),
    ),
    ...inspected,
  ]).map((record) => ({
    ...record,
    path: createPublicNativePath(record, [
      input.workspaceRoot,
      canonicalWorkspaceRoot,
    ]),
  }));
};
