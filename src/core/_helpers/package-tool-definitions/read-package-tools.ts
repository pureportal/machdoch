import { randomUUID } from "node:crypto";
import {
  coerceBoolean,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
} from "../agent-tools-shared.js";
import { createTextSection, limitText, stringifyUnknown } from "../runtime-text.js";
import { formatLocalCommandError } from "../process-execution.js";
import {
  coerceBoundedInteger,
  coerceScriptTimeout,
  normalizeScriptArgs,
  runPackageManager,
  scriptCommandArgs,
} from "./command-args.js";
import {
  DEFAULT_OUTDATED_RESULTS,
  MAX_OUTDATED_RESULTS,
  MAX_SCRIPT_TIMEOUT_MS,
  PACKAGE_TIMEOUT_MS,
} from "./model.js";
import {
  formatOutdatedEntry,
  outdatedCommandArgs,
  parseNodeOutdated,
} from "./outdated-parser.js";
import {
  dependencyCountLines,
  formatLockfile,
  formatManagerSource,
  formatWorkspacePackage,
} from "./project-formatters.js";
import { resolvePackageProject } from "./project.js";

export const createReadPackageToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
          spec: {
            name: "inspect_node_package",
            description:
              "Inspect a Node package manifest, scripts, dependency counts, lockfiles, detected package manager, and declared workspaces without mutating files.",
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
          effect: "read",
          execute: async (args, context) => {
            try {
              const project = await resolvePackageProject(
                context.workspaceRoot,
                coerceString(args, "packagePath"),
              );
              const scriptNames = Object.keys(project.manifest.scripts).sort();
              const lockfileLines = project.lockfiles.map(formatLockfile);
              const workspaceLines =
                project.workspacePackages.map(formatWorkspacePackage);
              const output = [
                `Package: ${project.manifest.name ?? "(unnamed)"}`,
                `Version: ${project.manifest.version ?? "(none)"}`,
                `Private: ${project.manifest.private === true ? "yes" : "no"}`,
                `Manager: ${project.manager}`,
                `Manager source: ${formatManagerSource(project)}`,
                `Package manager field: ${project.manifest.packageManager ?? "(none)"}`,
                `Package root: ${project.packageRoot}`,
                `Scripts: ${scriptNames.length > 0 ? scriptNames.join(", ") : "(none)"}`,
                ...dependencyCountLines(project.manifest),
                lockfileLines.length > 0
                  ? `Lockfiles: ${lockfileLines.join("; ")}`
                  : "Lockfiles: none detected",
                `Workspace patterns: ${project.manifest.workspaces.length > 0 ? project.manifest.workspaces.join(", ") : "(none)"}`,
                `Workspace packages: ${project.workspacePackages.length}`,
                workspaceLines.length > 0
                  ? ["Workspace package list:", ...workspaceLines].join("\n")
                  : undefined,
                project.lockfileWarnings.length > 0
                  ? `Warnings: ${project.lockfileWarnings.join(" ")}`
                  : undefined,
              ]
                .filter((part): part is string => typeof part === "string")
                .join("\n");
    
              return {
                toolResult: {
                  callId: randomUUID(),
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
                      `manager source: ${formatManagerSource(project)}`,
                      `package manager field: ${project.manifest.packageManager ?? "(none)"}`,
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
                  {
                    title: "Workspace packages",
                    lines:
                      workspaceLines.length > 0
                        ? workspaceLines
                        : project.manifest.workspaces.length > 0
                          ? ["No workspace package.json files matched."]
                          : ["No workspaces declared."],
                  },
                  ...(project.lockfileWarnings.length > 0
                    ? [
                        {
                          title: "Package manager warnings",
                          lines: project.lockfileWarnings,
                        },
                      ]
                    : []),
                ],
                traceLines: [
                  `inspect_node_package(${project.manifest.name ?? "unnamed"}) -> ${project.manager}`,
                ],
              };
            } catch (error) {
              return createToolErrorResult(
                randomUUID(),
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
          effect: "external-side-effect",
          execute: async (args, context) => {
            const script = coerceString(args, "script");
            const scriptArgs = normalizeScriptArgs(args.args);
    
            if (!script || scriptArgs === undefined) {
              return createToolErrorResult(
                randomUUID(),
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
                  randomUUID(),
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
                  callId: randomUUID(),
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
                randomUUID(),
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
              "Check registry metadata for outdated direct dependencies and return a concise JSON-derived summary. Supports npm and pnpm projects.",
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
                    "For npm only, include transitive dependencies using npm outdated --all.",
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
          effect: "external-read",
          execute: async (args, context) => {
            const maxResults = coerceBoundedInteger(
              args,
              "maxResults",
              DEFAULT_OUTDATED_RESULTS,
              MAX_OUTDATED_RESULTS,
            );
            const includeAll = coerceBoolean(args, "includeAll") ?? false;
    
            if (maxResults === undefined) {
              return createToolErrorResult(
                randomUUID(),
                "check_node_package_outdated",
                `Expected \`maxResults\` to be between 1 and ${MAX_OUTDATED_RESULTS}.`,
              );
            }
    
            try {
              const project = await resolvePackageProject(
                context.workspaceRoot,
                coerceString(args, "packagePath"),
              );
              const managerArgs = outdatedCommandArgs(project.manager, includeAll);
    
              if (!managerArgs) {
                return createToolErrorResult(
                  randomUUID(),
                  "check_node_package_outdated",
                  "Outdated checks currently support npm and pnpm projects only.",
                );
              }
    
              if (includeAll && project.manager !== "npm") {
                return createToolErrorResult(
                  randomUUID(),
                  "check_node_package_outdated",
                  "`includeAll` is currently supported for npm projects only.",
                );
              }
    
              const result = await runPackageManager(
                project,
                managerArgs,
                PACKAGE_TIMEOUT_MS,
                [0, 1],
              );
              const entries = parseNodeOutdated(result.stdout);
              const displayedEntries = entries.slice(0, maxResults);
              const entryLines = displayedEntries.map(formatOutdatedEntry);
              const output = [
                `Package: ${project.manifest.name ?? "(unnamed)"}`,
                `Manager: ${project.manager}`,
                `Outdated dependencies: ${entries.length}`,
                entryLines.length > 0
                  ? entryLines.join("\n")
                  : "No outdated dependencies reported by the package manager.",
                entries.length > maxResults
                  ? `... truncated after ${maxResults} of ${entries.length} entries`
                  : undefined,
              ]
                .filter((part): part is string => typeof part === "string")
                .join("\n");
    
              return {
                toolResult: {
                  callId: randomUUID(),
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
                      `exit code: ${result.exitCode}`,
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
                        : ["No outdated dependencies reported."],
                  },
                ],
                traceLines: [
                  `check_node_package_outdated(${project.manifest.name ?? "unnamed"}) -> ${entries.length} outdated`,
                ],
              };
            } catch (error) {
              return createToolErrorResult(
                randomUUID(),
                "check_node_package_outdated",
                error instanceof SyntaxError
                  ? `Package manager returned outdated data that could not be parsed as JSON: ${stringifyUnknown(error.message)}`
                  : formatLocalCommandError("package outdated check failed", error),
              );
            }
          },
        }
  ];
};
