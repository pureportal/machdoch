import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  coerceBoolean,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  isPathInsideWorkspace,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "./runtime-text.js";
import {
  executeLocalCommand,
  formatLocalCommandError,
  type LocalCommandResult,
} from "./process-execution.js";

const PACKAGE_TIMEOUT_MS = 120_000;
const PACKAGE_MAX_BUFFER_BYTES = 1_500_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
const MAX_SCRIPT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTDATED_RESULTS = 25;
const MAX_OUTDATED_RESULTS = 100;
const MAX_PACKAGE_SPECS = 20;
const MAX_PACKAGE_SPEC_LENGTH = 220;
const MAX_SCRIPT_ARGS = 40;
const MAX_SCRIPT_ARG_LENGTH = 1_000;

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];
type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";

interface NodePackageProject {
  packageRoot: string;
  packageJsonPath: string;
  manifest: PackageManifest;
  manager: NodePackageManager;
  lockfiles: PackageLockfileInfo[];
}

interface PackageLockfileInfo {
  name: string;
  manager: NodePackageManager;
  lockfileVersion?: number;
  packageCount?: number;
}

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies: Record<DependencySection, Record<string, string>>;
}

interface NpmOutdatedEntry {
  name: string;
  current?: string;
  wanted?: string;
  latest?: string;
  dependent?: string;
  location?: string;
  type?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const coerceStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" ? [[key, entry]] : [],
    ),
  );
};

const parsePackageManifest = (raw: string): PackageManifest => {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("package.json did not contain a JSON object.");
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(typeof parsed.private === "boolean"
      ? { private: parsed.private }
      : {}),
    ...(typeof parsed.packageManager === "string"
      ? { packageManager: parsed.packageManager }
      : {}),
    scripts: coerceStringRecord(parsed.scripts),
    dependencies: Object.fromEntries(
      DEPENDENCY_SECTIONS.map((section) => [
        section,
        coerceStringRecord(parsed[section]),
      ]),
    ) as Record<DependencySection, Record<string, string>>,
  };
};

const parsePackageLockMetadata = async (
  packageRoot: string,
): Promise<PackageLockfileInfo | undefined> => {
  const lockfilePath = join(packageRoot, "package-lock.json");

  if (!existsSync(lockfilePath)) {
    return undefined;
  }

  try {
    const raw = JSON.parse(
      await readFile(lockfilePath, "utf8"),
    ) as Record<string, unknown>;
    const packages = isRecord(raw.packages) ? raw.packages : undefined;

    return {
      name: "package-lock.json",
      manager: "npm",
      ...(typeof raw.lockfileVersion === "number"
        ? { lockfileVersion: raw.lockfileVersion }
        : {}),
      ...(packages ? { packageCount: Object.keys(packages).length } : {}),
    };
  } catch {
    return {
      name: "package-lock.json",
      manager: "npm",
    };
  }
};

const detectLockfiles = async (
  packageRoot: string,
): Promise<PackageLockfileInfo[]> => {
  const npmLockfile = await parsePackageLockMetadata(packageRoot);
  const lockfiles: PackageLockfileInfo[] = npmLockfile ? [npmLockfile] : [];

  for (const lockfile of [
    { name: "pnpm-lock.yaml", manager: "pnpm" },
    { name: "yarn.lock", manager: "yarn" },
    { name: "bun.lock", manager: "bun" },
    { name: "bun.lockb", manager: "bun" },
  ] as const) {
    if (existsSync(join(packageRoot, lockfile.name))) {
      lockfiles.push(lockfile);
    }
  }

  return lockfiles;
};

const managerFromPackageManagerField = (
  packageManager: string | undefined,
): NodePackageManager | undefined => {
  if (!packageManager) {
    return undefined;
  }

  const [manager] = packageManager.split("@");

  return ["npm", "pnpm", "yarn", "bun"].includes(manager ?? "")
    ? (manager as NodePackageManager)
    : undefined;
};

const detectPackageManager = (
  manifest: PackageManifest,
  lockfiles: PackageLockfileInfo[],
): NodePackageManager => {
  const explicitManager = managerFromPackageManagerField(
    manifest.packageManager,
  );

  if (explicitManager) {
    return explicitManager;
  }

  return lockfiles[0]?.manager ?? "npm";
};

const resolvePackageProject = async (
  workspaceRoot: string,
  requestedPath: string | undefined,
): Promise<NodePackageProject> => {
  const packageTarget = await resolveWorkspaceTarget(
    workspaceRoot,
    requestedPath ?? ".",
  );

  if (!packageTarget.insideWorkspace) {
    throw new Error(
      `Refusing package path \`${requestedPath ?? "."}\` because it resolves outside the workspace.`,
    );
  }

  const targetStats = await stat(packageTarget.resolvedPath);
  const packageJsonPath = targetStats.isDirectory()
    ? join(packageTarget.resolvedPath, "package.json")
    : packageTarget.resolvedPath;

  if (basename(packageJsonPath) !== "package.json") {
    throw new Error(
      "Expected `packagePath` to reference a package directory or package.json file.",
    );
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);
  const resolvedPackageJsonPath = await realpath(packageJsonPath);

  if (!isPathInsideWorkspace(resolvedWorkspaceRoot, resolvedPackageJsonPath)) {
    throw new Error(
      "The requested package.json resolves outside the active workspace boundary.",
    );
  }

  const packageRoot = dirname(resolvedPackageJsonPath);
  const rawManifest = await readFile(resolvedPackageJsonPath, "utf8");
  const manifest = parsePackageManifest(rawManifest);
  const lockfiles = await detectLockfiles(packageRoot);

  return {
    packageRoot,
    packageJsonPath: resolvedPackageJsonPath,
    manifest,
    manager: detectPackageManager(manifest, lockfiles),
    lockfiles,
  };
};

const dependencyCountLines = (manifest: PackageManifest): string[] => {
  return DEPENDENCY_SECTIONS.map((section) => {
    const count = Object.keys(manifest.dependencies[section]).length;
    return `${section}: ${count}`;
  });
};

const formatLockfile = (lockfile: PackageLockfileInfo): string => {
  return [
    `${lockfile.name} (${lockfile.manager})`,
    lockfile.lockfileVersion !== undefined
      ? `lockfileVersion=${lockfile.lockfileVersion}`
      : undefined,
    lockfile.packageCount !== undefined
      ? `packages=${lockfile.packageCount}`
      : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" · ");
};

const normalizeStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [entry.trim()]
      : [],
  );

  if (normalized.length > maxItems) {
    return undefined;
  }

  return normalized.every(
    (entry) => entry.length <= maxLength && !entry.includes("\0"),
  )
    ? normalized
    : undefined;
};

const normalizeScriptArgs = (value: unknown): string[] | undefined => {
  return value === undefined
    ? []
    : normalizeStringArray(value, MAX_SCRIPT_ARGS, MAX_SCRIPT_ARG_LENGTH);
};

const normalizePackageSpecs = (value: unknown): string[] | undefined => {
  const packageSpecs = normalizeStringArray(
    value,
    MAX_PACKAGE_SPECS,
    MAX_PACKAGE_SPEC_LENGTH,
  );

  if (!packageSpecs) {
    return undefined;
  }

  const invalidSpec = packageSpecs.find(
    (spec) =>
      /\s/u.test(spec) ||
      spec.startsWith("-") ||
      spec.startsWith(".") ||
      spec.startsWith("/") ||
      spec.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(spec) ||
      spec.startsWith("file:"),
  );

  return invalidSpec ? undefined : packageSpecs;
};

const scriptCommandArgs = (
  manager: NodePackageManager,
  script: string,
  scriptArgs: string[],
): string[] => {
  switch (manager) {
    case "npm": {
      return ["run", script, "--", ...scriptArgs];
    }
    case "pnpm":
    case "yarn":
    case "bun": {
      return ["run", script, ...scriptArgs];
    }
  }
};

const installCommandArgs = (
  manager: NodePackageManager,
  packageSpecs: string[],
  options: { dev: boolean; exact: boolean; lockfileOnly: boolean },
): string[] => {
  switch (manager) {
    case "npm": {
      return [
        "install",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...(options.lockfileOnly ? ["--package-lock-only"] : []),
        ...packageSpecs,
      ];
    }
    case "pnpm": {
      return [
        "add",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...packageSpecs,
      ];
    }
    case "yarn":
    case "bun": {
      return [
        "add",
        ...(options.dev ? ["--dev"] : []),
        ...(options.exact ? ["--exact"] : []),
        ...packageSpecs,
      ];
    }
  }
};

const runPackageManager = async (
  project: NodePackageProject,
  args: string[],
  timeoutMs = PACKAGE_TIMEOUT_MS,
  acceptedExitCodes?: number[],
): Promise<LocalCommandResult> => {
  return executeLocalCommand(project.manager, args, {
    cwd: project.packageRoot,
    timeoutMs,
    maxBufferBytes: PACKAGE_MAX_BUFFER_BYTES,
    ...(acceptedExitCodes ? { acceptedExitCodes } : {}),
  });
};

const coerceScriptTimeout = (args: Record<string, unknown>): number => {
  const timeoutMs =
    coerceInteger(args, "timeoutMs") ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  return Math.min(Math.max(timeoutMs, 1_000), MAX_SCRIPT_TIMEOUT_MS);
};

const parseNpmOutdated = (stdout: string): NpmOutdatedEntry[] => {
  if (!stdout.trim()) {
    return [];
  }

  const parsed = JSON.parse(stdout) as unknown;

  if (!isRecord(parsed)) {
    return [];
  }

  return Object.entries(parsed).flatMap(([name, value]) => {
    if (!isRecord(value)) {
      return [];
    }

    return [
      {
        name,
        ...(typeof value.current === "string"
          ? { current: value.current }
          : {}),
        ...(typeof value.wanted === "string" ? { wanted: value.wanted } : {}),
        ...(typeof value.latest === "string" ? { latest: value.latest } : {}),
        ...(typeof value.dependent === "string"
          ? { dependent: value.dependent }
          : {}),
        ...(typeof value.location === "string"
          ? { location: value.location }
          : {}),
        ...(typeof value.type === "string" ? { type: value.type } : {}),
      },
    ];
  });
};

const formatOutdatedEntry = (
  entry: NpmOutdatedEntry,
): string => {
  return [
    entry.name,
    `current=${entry.current ?? "unknown"}`,
    `wanted=${entry.wanted ?? "unknown"}`,
    `latest=${entry.latest ?? "unknown"}`,
    entry.type ? `type=${entry.type}` : undefined,
    entry.dependent ? `dependent=${entry.dependent}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" · ");
};

export const createPackageToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "inspect_node_package",
        description:
          "Inspect a Node package manifest, scripts, dependency counts, lockfiles, and detected package manager without mutating files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
          },
        },
      },
      backingTool: "packages",
      riskLevel: "low",
      execute: async (args, context) => {
        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const scriptNames = Object.keys(project.manifest.scripts).sort();
          const lockfileLines = project.lockfiles.map(formatLockfile);
          const output = [
            `Package: ${project.manifest.name ?? "(unnamed)"}`,
            `Version: ${project.manifest.version ?? "(none)"}`,
            `Private: ${project.manifest.private === true ? "yes" : "no"}`,
            `Manager: ${project.manager}`,
            `Package root: ${project.packageRoot}`,
            `Scripts: ${scriptNames.length > 0 ? scriptNames.join(", ") : "(none)"}`,
            ...dependencyCountLines(project.manifest),
            lockfileLines.length > 0
              ? `Lockfiles: ${lockfileLines.join("; ")}`
              : "Lockfiles: none detected",
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "inspect_node_package",
              output: limitText(output),
            },
            sections: [
              {
                title: "Node package",
                lines: [
                  `name: ${project.manifest.name ?? "(unnamed)"}`,
                  `version: ${project.manifest.version ?? "(none)"}`,
                  `private: ${project.manifest.private === true ? "yes" : "no"}`,
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                ],
              },
              {
                title: "Package scripts",
                lines:
                  scriptNames.length > 0
                    ? scriptNames.map(
                        (name) => `${name}: ${project.manifest.scripts[name]}`,
                      )
                    : ["No scripts are declared."],
              },
              {
                title: "Dependency counts",
                lines: dependencyCountLines(project.manifest),
              },
              {
                title: "Package lockfiles",
                lines:
                  lockfileLines.length > 0
                    ? lockfileLines
                    : ["No lockfiles detected."],
              },
            ],
            traceLines: [
              `inspect_node_package(${project.manifest.name ?? "unnamed"}) -> ${project.manager}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "inspect_node_package",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "run_node_package_script",
        description:
          "Run a declared package.json script through the detected package manager. Use this instead of a raw shell command when executing project scripts because it validates that the script exists first.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            script: {
              type: "string",
              description: "Script name from package.json, such as test.",
            },
            args: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional literal arguments to pass to the script after the package manager separator.",
            },
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
            timeoutMs: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_SCRIPT_TIMEOUT_MS,
              description: "Maximum script runtime before termination.",
            },
          },
          required: ["script"],
        },
      },
      backingTool: "packages",
      riskLevel: "high",
      execute: async (args, context) => {
        const script = coerceString(args, "script");
        const scriptArgs = normalizeScriptArgs(args.args);

        if (!script || scriptArgs === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_node_package_script",
            "Expected a declared `script` and an optional string-array `args`.",
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const scriptCommand = project.manifest.scripts[script];

          if (!scriptCommand) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "run_node_package_script",
              `The package.json file does not declare a \`${script}\` script.`,
            );
          }

          const managerArgs = scriptCommandArgs(
            project.manager,
            script,
            scriptArgs,
          );
          const result = await runPackageManager(
            project,
            managerArgs,
            coerceScriptTimeout(args),
          );
          const output = [
            `Command: ${project.manager} ${managerArgs.join(" ")}`,
            `Exit code: ${result.exitCode}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : undefined,
            result.stderr ? `STDERR:\n${result.stderr}` : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_node_package_script",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package script",
                lines: [
                  `manager: ${project.manager}`,
                  `script: ${script}`,
                  `package root: ${project.packageRoot}`,
                  `command: ${scriptCommand}`,
                  ...(scriptArgs.length > 0
                    ? [`args: ${scriptArgs.join(" ")}`]
                    : []),
                ],
              },
              createTextSection(
                "Script output",
                [result.stdout, result.stderr].filter(Boolean).join("\n\n") ||
                  "(no output)",
              ),
            ],
            traceLines: [
              `run_node_package_script(${script}) -> exit ${result.exitCode}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_node_package_script",
            formatLocalCommandError("package script failed", error),
          );
        }
      },
    },
    {
      spec: {
        name: "check_node_package_outdated",
        description:
          "Check npm registry metadata for outdated direct dependencies and return a concise JSON-derived summary. This currently supports npm projects.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
            includeAll: {
              type: "boolean",
              description:
                "Whether to include transitive dependencies using npm outdated --all.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_OUTDATED_RESULTS,
              description: "Maximum outdated entries to return.",
            },
          },
        },
      },
      backingTool: "packages",
      riskLevel: "medium",
      execute: async (args, context) => {
        const maxResults =
          coerceInteger(args, "maxResults") ?? DEFAULT_OUTDATED_RESULTS;

        if (maxResults < 1 || maxResults > MAX_OUTDATED_RESULTS) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "check_node_package_outdated",
            `Expected \`maxResults\` to be between 1 and ${MAX_OUTDATED_RESULTS}.`,
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );

          if (project.manager !== "npm") {
            return createToolErrorResult(
              crypto.randomUUID(),
              "check_node_package_outdated",
              "Outdated checks currently support npm projects only.",
            );
          }

          const result = await runPackageManager(
            project,
            [
              "outdated",
              "--json",
              ...(coerceBoolean(args, "includeAll") ? ["--all"] : []),
            ],
            PACKAGE_TIMEOUT_MS,
            [0, 1],
          );
          const entries = parseNpmOutdated(result.stdout);
          const displayedEntries = entries.slice(0, maxResults);
          const entryLines = displayedEntries.map(formatOutdatedEntry);
          const output = [
            `Package: ${project.manifest.name ?? "(unnamed)"}`,
            `Outdated dependencies: ${entries.length}`,
            entryLines.length > 0
              ? entryLines.join("\n")
              : "No outdated dependencies reported by npm.",
            entries.length > maxResults
              ? `... truncated after ${maxResults} of ${entries.length} entries`
              : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "check_node_package_outdated",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package outdated check",
                lines: [
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                  `outdated dependencies: ${entries.length}`,
                  `npm exit code: ${result.exitCode}`,
                ],
              },
              {
                title: "Outdated dependencies",
                lines:
                  entryLines.length > 0
                    ? [
                        ...entryLines,
                        ...(entries.length > maxResults
                          ? [
                              `... truncated after ${maxResults} of ${entries.length} entries`,
                            ]
                          : []),
                      ]
                    : ["No outdated dependencies reported by npm."],
              },
            ],
            traceLines: [
              `check_node_package_outdated(${project.manifest.name ?? "unnamed"}) -> ${entries.length} outdated`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "check_node_package_outdated",
            error instanceof SyntaxError
              ? `npm returned outdated data that could not be parsed as JSON: ${stringifyUnknown(error.message)}`
              : formatLocalCommandError("npm outdated failed", error),
          );
        }
      },
    },
    {
      spec: {
        name: "install_node_packages",
        description:
          "Install one or more registry package specs with the detected package manager. This mutates package.json, lockfiles, and usually node_modules; it never accepts local file specs.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            packages: {
              type: "array",
              minItems: 1,
              maxItems: MAX_PACKAGE_SPECS,
              items: { type: "string" },
              description:
                "Registry package specs such as react, @types/node, or vite@latest. Local file specs are rejected.",
            },
            dev: {
              type: "boolean",
              description: "Whether to save packages as development dependencies.",
            },
            exact: {
              type: "boolean",
              description: "Whether to save exact versions.",
            },
            lockfileOnly: {
              type: "boolean",
              description:
                "For npm projects only, update package.json/package-lock without installing into node_modules.",
            },
            packagePath: {
              type: "string",
              description:
                "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
            },
          },
          required: ["packages"],
        },
      },
      backingTool: "packages",
      riskLevel: "high",
      execute: async (args, context) => {
        const packageSpecs = normalizePackageSpecs(args.packages);

        if (!packageSpecs) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "install_node_packages",
            "Expected 1-20 registry package specs without whitespace, option prefixes, or local file paths.",
          );
        }

        try {
          const project = await resolvePackageProject(
            context.workspaceRoot,
            coerceString(args, "packagePath"),
          );
          const lockfileOnly = coerceBoolean(args, "lockfileOnly") ?? false;

          if (lockfileOnly && project.manager !== "npm") {
            return createToolErrorResult(
              crypto.randomUUID(),
              "install_node_packages",
              "`lockfileOnly` is currently supported for npm projects only.",
            );
          }

          const managerArgs = installCommandArgs(project.manager, packageSpecs, {
            dev: coerceBoolean(args, "dev") ?? false,
            exact: coerceBoolean(args, "exact") ?? false,
            lockfileOnly,
          });
          const result = await runPackageManager(project, managerArgs);
          const output = [
            `Command: ${project.manager} ${managerArgs.join(" ")}`,
            `Exit code: ${result.exitCode}`,
            result.stdout ? `STDOUT:\n${result.stdout}` : undefined,
            result.stderr ? `STDERR:\n${result.stderr}` : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "install_node_packages",
              output: limitText(output),
            },
            sections: [
              {
                title: "Package install",
                lines: [
                  `manager: ${project.manager}`,
                  `package root: ${project.packageRoot}`,
                  `packages: ${packageSpecs.join(", ")}`,
                  `dev: ${coerceBoolean(args, "dev") === true ? "yes" : "no"}`,
                  `exact: ${coerceBoolean(args, "exact") === true ? "yes" : "no"}`,
                  `lockfile only: ${lockfileOnly ? "yes" : "no"}`,
                ],
              },
              createTextSection(
                "Install output",
                [result.stdout, result.stderr].filter(Boolean).join("\n\n") ||
                  "(no output)",
              ),
            ],
            traceLines: [
              `install_node_packages(${packageSpecs.map(compactTraceText).join(", ")}) -> exit ${result.exitCode}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "install_node_packages",
            formatLocalCommandError("package install failed", error),
          );
        }
      },
    },
  ];
};
