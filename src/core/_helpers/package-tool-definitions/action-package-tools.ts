import { randomUUID } from "node:crypto";
import {
  coerceBoolean,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
} from "../agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
  stringifyUnknown,
} from "../runtime-text.js";
import { formatLocalCommandError } from "../process-execution.js";
import {
  auditAcceptedExitCodes,
  auditCommandArgs,
  formatAuditCounts,
  formatAuditEntry,
  parsePackageAudit,
} from "./audit-parser.js";
import {
  coerceAuditLevel,
  coerceBoundedInteger,
  installCommandArgs,
  normalizePackageSpecs,
  runPackageManager,
} from "./command-args.js";
import {
  CONFIGURABLE_AUDIT_LEVELS,
  DEFAULT_AUDIT_RESULTS,
  MAX_AUDIT_RESULTS,
  MAX_PACKAGE_SPECS,
  PACKAGE_AUDIT_TIMEOUT_MS,
} from "./model.js";
import { resolvePackageProject } from "./project.js";

export const createActionPackageToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
          spec: {
            name: "audit_node_package_dependencies",
            description:
              "Run a read-only package manager security audit and summarize vulnerabilities from JSON or JSON-lines output. Supports npm, pnpm, yarn, and bun projects.",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                packagePath: {
                  type: "string",
                  description:
                    "Optional workspace-relative package directory or package.json path. Defaults to the workspace root.",
                },
                auditLevel: {
                  type: "string",
                  enum: CONFIGURABLE_AUDIT_LEVELS,
                  description:
                    "Minimum severity requested from the package manager. Defaults to low.",
                },
                productionOnly: {
                  type: "boolean",
                  description:
                    "Exclude development dependencies where the detected package manager supports that audit filter.",
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: MAX_AUDIT_RESULTS,
                  description: "Maximum advisory entries to include.",
                },
              },
            },
          },
          backingTool: "packages",
          riskLevel: "medium",
          effect: "external-read",
          execute: async (args, context) => {
            const auditLevel = coerceAuditLevel(args);
            const maxResults = coerceBoundedInteger(
              args,
              "maxResults",
              DEFAULT_AUDIT_RESULTS,
              MAX_AUDIT_RESULTS,
            );
    
            if (!auditLevel) {
              return createToolErrorResult(
                randomUUID(),
                "audit_node_package_dependencies",
                "Expected `auditLevel` to be one of low, moderate, high, or critical.",
              );
            }
    
            if (maxResults === undefined) {
              return createToolErrorResult(
                randomUUID(),
                "audit_node_package_dependencies",
                `Expected \`maxResults\` to be between 1 and ${MAX_AUDIT_RESULTS}.`,
              );
            }
    
            try {
              const project = await resolvePackageProject(
                context.workspaceRoot,
                coerceString(args, "packagePath"),
              );
              const productionOnly =
                coerceBoolean(args, "productionOnly") ?? false;
              const managerArgs = auditCommandArgs(project, {
                auditLevel,
                productionOnly,
              });
              const result = await runPackageManager(
                project,
                managerArgs,
                PACKAGE_AUDIT_TIMEOUT_MS,
                auditAcceptedExitCodes(project),
              );
              const auditSummary = parsePackageAudit(result.stdout);
              const displayedEntries = auditSummary.entries.slice(0, maxResults);
              const entryLines = displayedEntries.map(formatAuditEntry);
              const output = [
                `Package: ${project.manifest.name ?? "(unnamed)"}`,
                `Manager: ${project.manager}`,
                `Audit level: ${auditLevel}`,
                `Production only: ${productionOnly ? "yes" : "no"}`,
                `Vulnerabilities: ${auditSummary.total}`,
                `Severity counts: ${formatAuditCounts(auditSummary.counts)}`,
                entryLines.length > 0
                  ? entryLines.join("\n")
                  : "No vulnerability entries were reported.",
                auditSummary.entries.length > maxResults
                  ? `... truncated after ${maxResults} of ${auditSummary.entries.length} entries`
                  : undefined,
              ]
                .filter((part): part is string => typeof part === "string")
                .join("\n");
    
              return {
                toolResult: {
                  callId: randomUUID(),
                  name: "audit_node_package_dependencies",
                  output: limitText(output),
                },
                sections: [
                  {
                    title: "Package audit",
                    lines: [
                      `manager: ${project.manager}`,
                      `package root: ${project.packageRoot}`,
                      `audit level: ${auditLevel}`,
                      `production only: ${productionOnly ? "yes" : "no"}`,
                      `vulnerabilities: ${auditSummary.total}`,
                      `severity counts: ${formatAuditCounts(auditSummary.counts)}`,
                      `exit code: ${result.exitCode}`,
                    ],
                  },
                  {
                    title: "Audit advisories",
                    lines:
                      entryLines.length > 0
                        ? [
                            ...entryLines,
                            ...(auditSummary.entries.length > maxResults
                              ? [
                                  `... truncated after ${maxResults} of ${auditSummary.entries.length} entries`,
                                ]
                              : []),
                          ]
                        : ["No vulnerability entries were reported."],
                  },
                ],
                traceLines: [
                  `audit_node_package_dependencies(${project.manifest.name ?? "unnamed"}) -> ${auditSummary.total} vulnerabilities`,
                ],
              };
            } catch (error) {
              return createToolErrorResult(
                randomUUID(),
                "audit_node_package_dependencies",
                error instanceof SyntaxError
                  ? `Package manager returned audit data that could not be parsed as JSON: ${stringifyUnknown(error.message)}`
                  : formatLocalCommandError("package audit failed", error),
              );
            }
          },
        },
    {
          spec: {
            name: "install_node_packages",
            description:
              "Install one or more registry package specs with the detected package manager. This mutates package.json, lockfiles, and usually node_modules; it never accepts local file, Git, or remote tarball specs.",
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
                    "Registry package specs such as react, @types/node, or vite@latest. Local file, Git, and remote tarball specs are rejected.",
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
                    "For npm and bun projects only, update lockfiles/package metadata without installing into node_modules.",
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
          effect: "write",
          execute: async (args, context) => {
            const packageSpecs = normalizePackageSpecs(args.packages);
    
            if (!packageSpecs) {
              return createToolErrorResult(
                randomUUID(),
                "install_node_packages",
                "Expected 1-20 registry package specs without whitespace, option prefixes, local file paths, Git specs, or remote tarballs.",
              );
            }
    
            try {
              const project = await resolvePackageProject(
                context.workspaceRoot,
                coerceString(args, "packagePath"),
              );
              const lockfileOnly = coerceBoolean(args, "lockfileOnly") ?? false;
    
              if (
                lockfileOnly &&
                project.manager !== "npm" &&
                project.manager !== "bun"
              ) {
                return createToolErrorResult(
                  randomUUID(),
                  "install_node_packages",
                  "`lockfileOnly` is currently supported for npm and bun projects only.",
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
                  callId: randomUUID(),
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
                randomUUID(),
                "install_node_packages",
                formatLocalCommandError("package install failed", error),
              );
            }
          },
        }
  ];
};
